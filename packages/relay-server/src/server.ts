/* eslint-disable max-lines -- 转发面（HTTP+三种 WS 管道+心跳+清扫）集中维护，拆散会让连接状态的所有权分叉。 */
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  decodeRemoteControlDataFrame,
  encodeRemoteControlDataFrame,
  parseRemoteControlDesktopFrame,
  parseRemoteControlDesktopFrameTolerant,
  parseRemoteControlRtcSignalTolerant,
  REMOTE_CONTROL_MAX_WS_MESSAGE_BYTES,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_CONTROL_TICKET_TTL_MS,
  REMOTE_CONTROL_WS_CLOSE,
  remoteControlRtcSignalSchema,
} from "@zcode/shared/remote-control";
import {
  RELAY_VERSION,
  REMOTE_CONTROL_PROTOCOL_MIN_DESKTOP_APP_VERSION,
  REMOTE_CONTROL_PROTOCOL_MIN_PAGE_VERSION,
} from "./version.js";
import { RateLimiter } from "./rateLimit.js";
import { RelayState, type RelayEffect } from "./state.js";

/**
 * 手机远控 relay 服务（spec §6）：设备注册、票据 bind、桌面/手机 WS 管道、
 * 帧转发、踢人、心跳、限频。全内存、不解析 RPC 载荷、日志不含业务内容。
 *
 * 职责边界：鉴权/票据/路由/转发只此一处；会话与任务状态永远在桌面 CLI 侧。
 */

const HEARTBEAT_PING_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;
/** 转发缓冲上限：超过即断管道，两端走快照恢复（对齐「溢出整批失败」哲学）。 */
const BACKPRESSURE_BUFFER_LIMIT_BYTES = REMOTE_CONTROL_MAX_WS_MESSAGE_BYTES * 4;
const HTTP_BODY_LIMIT_BYTES = 8 * 1024;
// 手机端 STUN 缺省列表：多服务器 + 国内可达项——单一 Google STUN 在大陆蜂窝网络常不可达，
// ICE 收集不到 srflx 候选导致 P2P 必败（spec §21.7，2026-09-24 真机结论）。
const DEFAULT_STUN_URLS = [
  "stun:stun.miwifi.com:3478",
  "stun:stun.qq.com:3478",
  "stun:stun.l.google.com:19302",
];

export interface RelayLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: RelayLogger = {
  info: (message, meta) => console.log(`[relay] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[relay] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[relay] ${message}`, meta ?? ""),
};

export interface RelayServerOptions {
  secret: string;
  /** 二维码落地页基址，如 https://m.example.com/remote */
  webRemoteBase: string;
  /** 对手机暴露的 WS 基址，如 wss://relay.example.com */
  publicWsBase: string;
  /** v2 P2P：下发给手机的 STUN 列表（运维可替换）。 */
  stunUrls?: string[];
  port?: number;
  host?: string;
  now?: () => number;
  logger?: RelayLogger;
}

export interface RelayServerHandle {
  httpServer: HttpServer;
  port: number;
  state: RelayState;
  close(): Promise<void>;
}

interface PhoneMeta {
  ua: string;
  p2pCapable: boolean;
}

interface TrackedSocket {
  ws: WebSocket;
  alive: boolean;
  lastSeenAt: number;
  kind: "desktop" | "phone" | "signal";
  key: string;
  phoneMeta?: PhoneMeta;
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServerHandle> {
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? Date.now;
  const state = new RelayState(options.secret, now);

  const httpServer = createServer((req, res) => handleHttpRequest(req, res));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_CONTROL_MAX_WS_MESSAGE_BYTES,
  });

  const sockets = new Set<TrackedSocket>();
  const desktopWsByMid = new Map<string, TrackedSocket>();
  const phoneWsBySid = new Map<string, TrackedSocket>();
  const signalWsBySid = new Map<string, TrackedSocket>();

  const bindLimiter = new RateLimiter(10, 60_000, now);
  const deviceLimiter = new RateLimiter(30, 60_000, now);
  const upgradeLimiter = new RateLimiter(30, 60_000, now);

  // ==========================================================================
  // HTTP
  // ==========================================================================

  /** 手机落地页与 relay 不同源，bind 必须放行跨域（票据本身即凭证，无 cookie 可泄露）。 */
  /** 限频键：优先 XFF 首值（Cloudflare Worker 代理透传真实 IP），回退 socket 地址。 */
  function clientRateKey(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim().length > 0) {
      return forwarded.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function setCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).byteLength;
      if (total > HTTP_BODY_LIMIT_BYTES) {
        return null;
      }
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return null;
    }
  }

  function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      // 版本能力报告（spec §22）：桌面据此做最低版本门控；字段只增不改，旧客户端容忍。
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          version: RELAY_VERSION,
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          minDesktopAppVersion: REMOTE_CONTROL_PROTOCOL_MIN_DESKTOP_APP_VERSION,
          minPageVersion: REMOTE_CONTROL_PROTOCOL_MIN_PAGE_VERSION,
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rc/devices") {
      void handleDeviceRegister(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/rc/bind") {
      void handleBind(req, res);
      return;
    }
    res
      .writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "not_found" }));
  }

  async function handleDeviceRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    const ip = clientRateKey(req);
    if (!deviceLimiter.allow(ip)) {
      res
        .writeHead(429, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    const body = (await readJsonBody(req)) as {
      mid?: unknown;
      name?: unknown;
      appVersion?: unknown;
    } | null;
    if (
      !body ||
      typeof body.mid !== "string" ||
      body.mid.length === 0 ||
      body.mid.length > 128 ||
      typeof body.name !== "string" ||
      body.name.length > 256 ||
      typeof body.appVersion !== "string" ||
      body.appVersion.length > 64
    ) {
      deviceLimiter.strike(ip);
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    const { deviceToken } = state.registerDevice({
      mid: body.mid,
      name: body.name,
      appVersion: body.appVersion,
    });
    logger.info("device registered", { mid: body.mid });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ deviceToken }));
  }

  async function handleBind(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    const ip = clientRateKey(req);
    if (!bindLimiter.allow(ip)) {
      res
        .writeHead(429, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    const body = (await readJsonBody(req)) as {
      sid?: unknown;
      hash?: unknown;
      t?: unknown;
      mid?: unknown;
    } | null;
    if (
      !body ||
      typeof body.sid !== "string" ||
      typeof body.hash !== "string" ||
      typeof body.t !== "number" ||
      typeof body.mid !== "string"
    ) {
      bindLimiter.strike(ip);
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "ticket_invalid" }));
      return;
    }
    const result = state.bindTicket({ sid: body.sid, hash: body.hash, t: body.t, mid: body.mid });
    if (!result.ok) {
      bindLimiter.strike(ip);
      logger.warn("bind rejected", { sid: body.sid, error: result.error });
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: result.error }));
      return;
    }
    bindLimiter.resetStrikes(ip);
    const device = state.devices.get(body.mid);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        sessionToken: result.sessionToken,
        desktopName: device?.name ?? "",
        relayWsBase: options.publicWsBase,
        // 协议能力声明（spec §22）：旧手机端按 unknown 容忍；新手机端低于 minPageVersion 提示刷新。
        relayCapabilities: {
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          minPageVersion: REMOTE_CONTROL_PROTOCOL_MIN_PAGE_VERSION,
        },
      }),
    );
  }

  // ==========================================================================
  // 副作用执行（effects → 网络）
  // ==========================================================================

  function sendDesktopControl(mid: string, frame: Record<string, unknown>): boolean {
    const tracked = desktopWsByMid.get(mid);
    if (!tracked || tracked.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    tracked.ws.send(JSON.stringify(frame));
    return true;
  }

  function closeTracked(target: TrackedSocket | undefined, code: number, reason: string): void {
    if (!target) {
      return;
    }
    try {
      target.ws.close(code, reason);
    } catch {
      target.ws.terminate();
    }
  }

  /**
   * 执行状态机 effects。exceptPhoneWs 用于同 sid 自顶替：新连接先登记，
   * close_phone 跳过新连接本身，只影响旧 socket。
   */
  function executeEffects(effects: readonly RelayEffect[], exceptPhoneWs?: WebSocket): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "session_invalid": {
          const session = state.sessions.get(effect.sid);
          if (session) {
            sendDesktopControl(session.mid, {
              v: REMOTE_CONTROL_PROTOCOL_VERSION,
              type: "session_invalid",
              sid: effect.sid,
              reason: effect.reason,
            });
          }
          break;
        }
        case "stream_open": {
          const session = state.sessions.get(effect.sid);
          const phone = phoneWsBySid.get(effect.sid);
          if (session) {
            sendDesktopControl(session.mid, {
              v: REMOTE_CONTROL_PROTOCOL_VERSION,
              type: "stream_open",
              streamId: effect.streamId,
              sid: effect.sid,
              phone: {
                ua: phone?.phoneMeta?.ua ?? "",
                p2pCapable: phone?.phoneMeta?.p2pCapable ?? false,
              },
              transport: "relay",
            });
          }
          break;
        }
        case "stream_close": {
          // streamId 每桌面连接独立分配，全局不唯一；必须按 effect 自带的 sid 路由。
          const session = state.sessions.get(effect.sid);
          if (session) {
            sendDesktopControl(session.mid, {
              v: REMOTE_CONTROL_PROTOCOL_VERSION,
              type: "stream_close",
              streamId: effect.streamId,
              // sid 一并下发：桌面据此判定 P2P 会话被顶替（spec §21.6）。
              sid: effect.sid,
              reason: effect.reason,
            });
          }
          break;
        }
        case "close_phone": {
          const target = phoneWsBySid.get(effect.sid);
          if (target && target.ws !== exceptPhoneWs) {
            closeTracked(target, effect.code, effect.reason);
          }
          closeTracked(signalWsBySid.get(effect.sid), effect.code, effect.reason);
          break;
        }
      }
    }
  }

  // ==========================================================================
  // WS 升级路由
  // ==========================================================================

  function upgradeThenClose(
    req: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
    code: number,
    reason: string,
  ): void {
    // 先完成升级再按契约 close code 关闭，手机端 onclose 才能拿到语义。
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(code, reason);
    });
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    const ip = clientRateKey(req);
    if (!upgradeLimiter.allow(ip)) {
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws/desktop") {
      const mid = url.searchParams.get("mid");
      const token = url.searchParams.get("token");
      if (!mid || !token || !state.verifyDeviceToken(mid, token)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        onDesktopConnection(ws, mid);
      });
      return;
    }
    if (url.pathname === "/ws/phone" || url.pathname === "/ws/signal") {
      const sid = url.searchParams.get("sid");
      const token = url.searchParams.get("token");
      if (!sid || !token) {
        socket.destroy();
        return;
      }
      const check = state.checkPhoneUpgrade(sid, token);
      if (!check.ok) {
        upgradeThenClose(req, socket, head, check.closeCode, check.reason);
        return;
      }
      if (url.pathname === "/ws/phone" && !state.desktopRoutes.has(check.session.mid)) {
        upgradeThenClose(
          req,
          socket,
          head,
          REMOTE_CONTROL_WS_CLOSE.DESKTOP_OFFLINE,
          "desktop-offline",
        );
        return;
      }
      const phoneMeta: PhoneMeta = {
        ua: (url.searchParams.get("ua") ?? "").slice(0, 256),
        p2pCapable: url.searchParams.get("p2p") === "1",
      };
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (url.pathname === "/ws/phone") {
          onPhoneConnection(ws, check.session.sid, check.session.mid, phoneMeta);
        } else {
          onSignalConnection(ws, check.session.sid);
        }
      });
      return;
    }
    socket.destroy();
  });

  // ==========================================================================
  // 桌面连接
  // ==========================================================================

  function onDesktopConnection(ws: WebSocket, mid: string): void {
    // 同 mid 二连（桌面残留连接）：新连接顶替，旧管道回收。
    const previous = desktopWsByMid.get(mid);
    if (previous) {
      desktopWsByMid.delete(mid);
      executeEffects(state.desktopDisconnected(mid));
      state.desktopRoutes.delete(mid);
      sockets.delete(previous);
      previous.ws.terminate();
    }
    const tracked: TrackedSocket = {
      ws,
      alive: true,
      lastSeenAt: Date.now(),
      kind: "desktop",
      key: mid,
    };
    sockets.add(tracked);
    desktopWsByMid.set(mid, tracked);
    state.desktopRoutes.set(mid, { nextStreamId: 0 });
    ws.on("pong", () => {
      touch(tracked);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      touch(tracked);
      if (isBinary) {
        handleDesktopBinary(tracked, mid, data);
        return;
      }
      handleDesktopControl(tracked, mid, data.toString("utf8"));
    });
    ws.on("close", () => {
      sockets.delete(tracked);
      if (desktopWsByMid.get(mid) === tracked) {
        desktopWsByMid.delete(mid);
        // 必须先执行断开 effects（按 route 查 activeStream 关手机管道）再删 route，
        // 顺序颠倒会让 desktopDisconnected 找不到 activeStream 而静默漏关手机。
        executeEffects(state.desktopDisconnected(mid));
        state.desktopRoutes.delete(mid);
        logger.info("desktop disconnected", { mid });
      }
    });
    ws.on("error", () => {
      ws.terminate();
    });
    ws.send(JSON.stringify({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "register_ok" }));
    logger.info("desktop connected", { mid });
  }

  function handleDesktopControl(tracked: TrackedSocket, mid: string, raw: string): void {
    const frame = parseRemoteControlDesktopFrameTolerant(raw);
    if (!frame) {
      logger.warn("desktop sent invalid control frame", { mid });
      tracked.ws.close(1002, "invalid-control-frame");
      return;
    }
    state.touchDevice(mid);
    switch (frame.type) {
      case "register": {
        const device = state.devices.get(mid);
        if (device) {
          device.name = frame.name.slice(0, 256);
          device.appVersion = frame.appVersion.slice(0, 64);
        }
        tracked.ws.send(
          JSON.stringify({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "register_ok" }),
        );
        return;
      }
      case "issue_session": {
        const issued = state.issueSession(mid, { persistent: frame.persistent === true });
        executeEffects(issued.effects);
        const device = state.devices.get(mid);
        const ticketUrl = new URL(options.webRemoteBase);
        ticketUrl.searchParams.set("sid", issued.sid);
        ticketUrl.searchParams.set("hash", issued.accessHash);
        ticketUrl.searchParams.set("t", String(issued.issuedAt));
        ticketUrl.searchParams.set("mid", mid);
        ticketUrl.searchParams.set("name", device?.name ?? "");
        ticketUrl.searchParams.set("v", device?.appVersion ?? "");
        // spec §5.3 增补：运行时下发 WS 基址，relay 域名迁移时手机页免重新构建。
        if (options.publicWsBase) {
          ticketUrl.searchParams.set("ws", options.publicWsBase);
        }
        tracked.ws.send(
          JSON.stringify({
            v: REMOTE_CONTROL_PROTOCOL_VERSION,
            type: "session_issued",
            sid: issued.sid,
            url: ticketUrl.toString(),
            // 长效票据（spec §21.1）无到期时刻。
            expiresAt: issued.persistent ? null : issued.issuedAt + REMOTE_CONTROL_TICKET_TTL_MS,
          }),
        );
        return;
      }
      case "disconnect_session": {
        // 桌面主动断开当前设备（spec §21.2）：票据保留，手机可凭原链接重新 bind。
        executeEffects(state.disconnectSession(frame.sid));
        return;
      }
      case "revoke_session": {
        executeEffects(state.revokeSession(frame.sid));
        return;
      }
      case "stream_accepted": {
        return;
      }
      case "stream_close_notify": {
        // 桌面侧 Host attachment 端口已关：断开手机数据管道，手机会带 token 重连。
        const sid = activeSidByStreamId(mid, frame.streamId);
        if (sid) {
          closeTracked(phoneWsBySid.get(sid), 1000, "host-port-closed");
        }
        return;
      }
      case "rtc_signal": {
        const sid = activeSidByStreamId(mid, frame.streamId);
        if (!sid) {
          logger.warn("rtc_signal dropped: no sid for stream", {
            mid,
            streamId: frame.streamId,
            kind: (frame.data as { kind?: string }).kind,
          });
          return;
        }
        const signal = signalWsBySid.get(sid);
        if (signal?.ws.readyState === WebSocket.OPEN) {
          state.touchSession(sid);
          signal.ws.send(JSON.stringify(frame.data));
        } else {
          logger.warn("rtc_signal dropped: signal ws not open", {
            sid,
            kind: (frame.data as { kind?: string }).kind,
          });
        }
        return;
      }
      default: {
        logger.warn("desktop sent unexpected frame", {
          mid,
          type: (frame as { type: string }).type,
        });
      }
    }
  }

  function activeSidByStreamId(mid: string, streamId: number): string | undefined {
    const route = state.desktopRoutes.get(mid);
    return route?.activeStream?.streamId === streamId ? route.activeStream.sid : undefined;
  }

  function handleDesktopBinary(tracked: TrackedSocket, mid: string, data: RawData): void {
    const bytes = new Uint8Array(data as Buffer);
    const decoded = decodeRemoteControlDataFrame(bytes);
    if (!decoded) {
      tracked.ws.close(1002, "invalid-data-frame");
      return;
    }
    const route = state.desktopRoutes.get(mid);
    if (!route?.activeStream || route.activeStream.streamId !== decoded.streamId) {
      return; // 迟到帧：目标管道已换代，静默丢弃（对齐幂等回收语义）。
    }
    const sid = route.activeStream.sid;
    const phone = phoneWsBySid.get(sid);
    if (!phone || phone.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (phone.ws.bufferedAmount > BACKPRESSURE_BUFFER_LIMIT_BYTES) {
      logger.warn("phone backpressure overflow, dropping pipe", { sid });
      phone.ws.terminate();
      executeEffects(state.phoneDisconnected(sid));
      return;
    }
    state.touchSession(sid);
    phone.ws.send(decoded.payload, { binary: true });
  }

  // ==========================================================================
  // 手机连接（数据管道）
  // ==========================================================================

  function onPhoneConnection(ws: WebSocket, sid: string, mid: string, phoneMeta: PhoneMeta): void {
    // 先登记新连接再执行踢人 effects：同 sid 自顶替时 close_phone 跳过新连接，
    // 其他 sid 的踢人不受影响（exceptPhoneWs 只豁免自身）。
    const tracked: TrackedSocket = {
      ws,
      alive: true,
      lastSeenAt: Date.now(),
      kind: "phone",
      key: sid,
      phoneMeta,
    };
    sockets.add(tracked);
    phoneWsBySid.set(sid, tracked);
    const { effects, streamId } = state.bindPhoneStream(mid, sid);
    if (streamId < 0) {
      phoneWsBySid.delete(sid);
      sockets.delete(tracked);
      ws.close(REMOTE_CONTROL_WS_CLOSE.SESSION_EXPIRED, "bind-failed");
      return;
    }
    executeEffects(effects, ws);
    ws.on("pong", () => {
      touch(tracked);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      touch(tracked);
      if (!isBinary) {
        return; // 数据管道零 text 混入（spec §5.1）；text 一律忽略。
      }
      const session = state.sessions.get(sid);
      if (!session) {
        return;
      }
      const route = state.desktopRoutes.get(session.mid);
      if (!route?.activeStream || route.activeStream.sid !== sid) {
        return;
      }
      const desktop = desktopWsByMid.get(session.mid);
      if (!desktop || desktop.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (desktop.ws.bufferedAmount > BACKPRESSURE_BUFFER_LIMIT_BYTES) {
        logger.warn("desktop backpressure overflow, dropping pipe", { sid });
        desktop.ws.terminate();
        return;
      }
      state.touchSession(sid);
      desktop.ws.send(
        encodeRemoteControlDataFrame(route.activeStream.streamId, new Uint8Array(data as Buffer)),
        {
          binary: true,
        },
      );
    });
    ws.on("close", (code: number) => {
      sockets.delete(tracked);
      if (phoneWsBySid.get(sid) === tracked) {
        phoneWsBySid.delete(sid);
        if (code === REMOTE_CONTROL_WS_CLOSE.P2P_PROMOTED) {
          executeEffects(state.phonePromotedToP2p(sid));
        } else {
          executeEffects(state.phoneDisconnected(sid));
        }
      }
    });
    ws.on("error", () => {
      ws.terminate();
    });
    logger.info("phone stream bound", { sid, streamId });
  }

  // ==========================================================================
  // 手机连接（v2 信令管道）
  // ==========================================================================

  function onSignalConnection(ws: WebSocket, sid: string): void {
    const previous = signalWsBySid.get(sid);
    if (previous) {
      sockets.delete(previous);
      previous.ws.terminate();
    }
    const tracked: TrackedSocket = {
      ws,
      alive: true,
      lastSeenAt: Date.now(),
      kind: "signal",
      key: sid,
    };
    sockets.add(tracked);
    signalWsBySid.set(sid, tracked);
    logger.info("signal connected", { sid });
    // relay 注入 STUN 配置（spec §9.1：不依赖桌面版本，运维可替换）。
    ws.send(
      JSON.stringify({
        kind: "config",
        iceServers: { urls: options.stunUrls ?? DEFAULT_STUN_URLS },
      }),
    );
    ws.on("pong", () => {
      touch(tracked);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      touch(tracked);
      if (isBinary) {
        return; // 信令管道只承载 JSON 信令。
      }
      const parsed = parseRemoteControlRtcSignalTolerant(data.toString("utf8"));
      if (!parsed) {
        return;
      }
      state.touchSession(sid);
      const session = state.sessions.get(sid);
      const route = session ? state.desktopRoutes.get(session.mid) : undefined;
      if (session && route?.activeStream && route.activeStream.sid === sid) {
        sendDesktopControl(session.mid, {
          v: REMOTE_CONTROL_PROTOCOL_VERSION,
          type: "rtc_signal",
          streamId: route.activeStream.streamId,
          data: parsed,
        });
      }
    });
    ws.on("close", () => {
      sockets.delete(tracked);
      if (signalWsBySid.get(sid) === tracked) {
        signalWsBySid.delete(sid);
        logger.info("signal closed", { sid });
      }
    });
    ws.on("error", () => {
      ws.terminate();
    });
  }

  // ==========================================================================
  // 心跳与清扫
  // ==========================================================================

  function touch(tracked: TrackedSocket): void {
    tracked.alive = true;
    tracked.lastSeenAt = Date.now();
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const tracked of sockets) {
      // 判死窗口 = HEARTBEAT_TIMEOUT_MS（spec §5.1）：弱网容忍 60s 无 pong。
      if (now - tracked.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        tracked.ws.terminate();
        continue;
      }
      try {
        tracked.ws.ping();
      } catch {
        tracked.ws.terminate();
      }
    }
  }, HEARTBEAT_PING_MS);
  heartbeat.unref?.();

  const sweeper = setInterval(() => {
    executeEffects(state.sweep());
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  // ==========================================================================
  // 启动 / 关闭
  // ==========================================================================

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      resolve();
    });
  });

  const boundPort = (httpServer.address() as AddressInfo).port;

  return {
    httpServer,
    port: boundPort,
    state,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const tracked of sockets) {
        tracked.ws.terminate();
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
