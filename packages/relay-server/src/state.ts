/* eslint-disable max-lines -- 会话状态机（devices/sessions/routes）是单一所有者闭环，拆散会造成跨文件共享可变状态（与 server.ts/service.ts 同例）。 */
import {
  REMOTE_CONTROL_SESSION_IDLE_TTL_MS,
  REMOTE_CONTROL_SESSION_TTL_MS,
  REMOTE_CONTROL_TICKET_TTL_MS,
} from "@zcode/shared/remote-control";
import {
  computeAccessHash,
  hashDeviceToken,
  newOpaqueToken,
  newSessionId,
  verifyAccessHash,
} from "./tickets.js";

/**
 * relay 会话状态机（spec §6.2/§6.4），纯逻辑、零 IO、时钟可注入。
 *
 * 所有状态迁移返回 effects 数组，由 server.ts 执行实际的网络副作用；
 * 单测因此不需要任何 socket。状态所有权：
 *   devices / sessions / mid→activeStream 路由的唯一所有者都在本模块，
 *   server.ts 只做传输适配，不持有第二份可写状态。
 */

export const READY_TO_UPGRADE_GRACE_MS = 60_000;

export interface RelayDeviceRecord {
  tokenHash: string;
  name: string;
  appVersion: string;
  lastSeenAt: number;
}

export type RelaySessionState = "pending" | "ready" | "bound" | "grace" | "closed";

/** closed 会话的物理回收窗口。 */
const CLOSED_SESSION_RETENTION_MS = 10 * 60_000;

export interface RelaySession {
  sid: string;
  mid: string;
  issuedAt: number;
  state: RelaySessionState;
  /** 长效票据（spec §21.1）：无 TTL，仅被替换/撤销/断开后作废。 */
  persistent?: boolean;
  /** bind 成功后签发的会话凭证。 */
  sessionToken?: string;
  /** 滑动过期锚点（活跃续期）。 */
  tokenExpiresAt?: number;
  /** 手机断开(grace)锚点。 */
  disconnectedAt?: number;
  /** ready 状态等待手机 WSS 升级的期限。 */
  readyDeadline?: number;
  /** bound 时占用的桌面 streamId。 */
  streamId?: number;
  /** 进入 closed 的时刻（sweep 回收用）。 */
  closedAt?: number;
  /** 被新设备顶替而作废（spec §21.6）：该会话手机重连时收 4001 而非 4004，据此展示「已在其他设备登录」。 */
  closedByKick?: boolean;
  /** 被新 bind 顶替的历史 token（spec §21.6）：同二维码转移场景旧设备重连据此收 4001。 */
  supersededTokens?: string[];
  /** 在线期间 token 被重铸（spec §21.9）：下一次同 sid 升级按新设备转移处理。 */
  tokenRemintedAfterBound?: boolean;
  /** 桌面主动断开时被作废的 token（spec §21.2）：旧手机凭其重连收 4006 展示「已在电脑端断开连接」。 */
  disconnectedTokens?: string[];
}

export interface RelayActiveStream {
  streamId: number;
  sid: string;
}

export interface RelayDesktopRoute {
  nextStreamId: number;
  activeStream?: RelayActiveStream;
  /**
   * 最后一个占据该桌面「单设备名额」的会话。手机断开进入 grace 或升级 P2P 后
   * activeStream 清空，但名额仍被它持有：新设备扫码绑定必须把 grace 中的旧会话踢下线。
   */
  boundSid?: string;
  /** 当前唯一活票据（spec §21.1 单活票据：新签发即替换并关闭旧票据）。 */
  activeTicketSid?: string;
}

/**
 * 状态迁移需要的外部副作用。close_phone 只关数据管道（/ws/phone）；
 * 信令管道（/ws/signal）由 server 按 sid 一并关闭。
 */
export type RelayEffect =
  | {
      kind: "session_invalid";
      sid: string;
      reason: "consumed" | "expired" | "unknown" | "superseded";
    }
  | {
      kind: "stream_open";
      streamId: number;
      sid: string;
    }
  | {
      kind: "stream_close";
      streamId: number;
      /** streamId 每条桌面连接独立分配、全局不唯一；路由必须按 sid 反查 mid。 */
      sid: string;
      reason: "lost" | "kicked" | "phone_stop" | "p2p_promoted";
    }
  | { kind: "close_phone"; sid: string; code: number; reason: string };

export type BindTicketResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: "ticket_invalid" };

export type PhoneUpgradeCheck =
  | { ok: true; session: RelaySession }
  | { ok: false; closeCode: number; reason: string };

export class RelayState {
  readonly devices = new Map<string, RelayDeviceRecord>();
  readonly sessions = new Map<string, RelaySession>();
  readonly desktopRoutes = new Map<string, RelayDesktopRoute>();

  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  // ==========================================================================
  // 设备（spec §5.2）：注册即换发，relay 只存哈希。
  // ==========================================================================

  registerDevice(input: { mid: string; name: string; appVersion: string }): {
    deviceToken: string;
  } {
    const deviceToken = newOpaqueToken();
    this.devices.set(input.mid, {
      tokenHash: hashDeviceToken(deviceToken),
      name: input.name,
      appVersion: input.appVersion,
      lastSeenAt: this.now(),
    });
    return { deviceToken };
  }

  verifyDeviceToken(mid: string, token: string): boolean {
    const device = this.devices.get(mid);
    return device != null && device.tokenHash === hashDeviceToken(token);
  }

  touchDevice(mid: string): void {
    const device = this.devices.get(mid);
    if (device) {
      device.lastSeenAt = this.now();
    }
  }

  // ==========================================================================
  // 票据签发与消费（spec §5.3）
  // ==========================================================================

  issueSession(
    mid: string,
    options?: { persistent?: boolean },
  ): {
    sid: string;
    accessHash: string;
    issuedAt: number;
    persistent: boolean;
    effects: RelayEffect[];
  } {
    const sid = newSessionId();
    const issuedAt = this.now();
    const persistent = options?.persistent === true;
    const accessHash = computeAccessHash(this.secret, sid, mid, issuedAt, persistent);
    this.sessions.set(sid, {
      sid,
      mid,
      issuedAt,
      state: "pending",
      persistent,
    });
    // 单活票据（spec §21.1/§21.8）：新签发作废同 mid 的旧票据；但 bound/grace 的旧会话
    // （手机在线或宽限中）不踢——二维码区常驻后，连接中重签/切换自动刷新不得打断在线会话；
    // 旧会话自然结束后票据即失效，新设备扫新码仍经 bindPhoneStream 踢旧（单设备语义不变）。
    const effects: RelayEffect[] = [];
    const route = this.desktopRoutes.get(mid);
    const previousTicketSid = route?.activeTicketSid;
    if (route && previousTicketSid && previousTicketSid !== sid) {
      const previous = this.sessions.get(previousTicketSid);
      if (
        previous &&
        previous.state !== "closed" &&
        previous.state !== "bound" &&
        previous.state !== "grace"
      ) {
        previous.closedByKick = true;
        effects.push({
          kind: "close_phone",
          sid: previousTicketSid,
          code: 4001,
          reason: "superseded",
        });
        previous.state = "closed";
        previous.closedAt = this.now();
        // 不发 session_invalid(superseded)：替换由桌面自己发起，随后的 session_issued 即为回执；
        // 若先回发 invalid，会与新一轮 issued 竞态命中桌面「sid 相等即重签」逻辑，造成无限换码（2026-09-24 修复）。
      }
    }
    if (route) {
      route.activeTicketSid = sid;
    }
    return { sid, accessHash, issuedAt, persistent, effects };
  }

  /**
   * 手机消费二维码票据（spec §21.1：多次使用）。
   * pending/ready/bound/grace 均可再次 bind；每次 bind 重铸 sessionToken（旧 token 立即失效）。
   */
  bindTicket(input: { sid: string; hash: string; t: number; mid: string }): BindTicketResult {
    const session = this.sessions.get(input.sid);
    const now = this.now();
    if (!session || session.mid !== input.mid || session.state === "closed") {
      return { ok: false, error: "ticket_invalid" };
    }
    // 先验签名再判 TTL：签名不合法的请求不得引起任何状态变更（防伪造 t 作废他人票据）。
    if (
      !verifyAccessHash(this.secret, input.sid, input.mid, input.t, input.hash, session.persistent)
    ) {
      return { ok: false, error: "ticket_invalid" };
    }
    // 长效票据（persistent）无 TTL；短时票据按签发时刻判定过期。
    if (!session.persistent && now > input.t + REMOTE_CONTROL_TICKET_TTL_MS) {
      session.state = "closed";
      session.closedAt = now;
      return { ok: false, error: "ticket_invalid" };
    }
    // bound 期间再次 bind（设备转移）：只重铸 token，保持 bound 状态——
    // 若新设备 60s 内未升级 WS，旧设备仍在管道上不受影响；升级即由 bindPhoneStream 踢旧。
    // 旧 token 登记 supersededTokens：被顶替的旧设备（中转/P2P）重连时收 4001（spec §21.6）。
    const replacedToken =
      session.state === "bound" || session.state === "grace" ? session.sessionToken : undefined;
    session.sessionToken = newOpaqueToken();
    if (replacedToken) {
      (session.supersededTokens ??= []).push(replacedToken);
      if (session.supersededTokens.length > 4) {
        session.supersededTokens.splice(0, session.supersededTokens.length - 4);
      }
      if (session.state === "bound") {
        // 在线设备被换 token = 新设备转移（spec §21.9）：升级时需踢残留（含 P2P）。
        session.tokenRemintedAfterBound = true;
      }
    }
    session.tokenExpiresAt = now + REMOTE_CONTROL_SESSION_TTL_MS;
    if (session.state !== "bound") {
      session.state = "ready";
      session.readyDeadline = now + READY_TO_UPGRADE_GRACE_MS;
      session.disconnectedAt = undefined;
    }
    return { ok: true, sessionToken: session.sessionToken };
  }

  /**
   * 桌面主动断开当前设备（spec §21.2）：手机收 4006，会话回退 pending（票据仍可重新 bind）。
   */
  disconnectSession(sid: string): RelayEffect[] {
    const session = this.sessions.get(sid);
    if (!session || session.state === "closed") {
      return [];
    }
    const effects: RelayEffect[] = [
      { kind: "close_phone", sid, code: 4006, reason: "desktop-disconnected" },
    ];
    const route = this.desktopRoutes.get(session.mid);
    // P2P 已升级的会话：close_phone 触达不了手机（中转管道退役），桌面须凭 stream_close
    // 拆除 DataChannel——与踢人（§21.9）同型，streamId 用会话保留的旧值兜底。
    const notifiedStreamId =
      route?.activeStream?.sid === sid
        ? route.activeStream.streamId
        : (session.streamId ?? undefined);
    if (route?.activeStream?.sid === sid) {
      route.activeStream = undefined;
    }
    if (notifiedStreamId != null) {
      effects.push({
        kind: "stream_close",
        streamId: notifiedStreamId,
        sid,
        reason: "phone_stop",
      });
    }
    if (route?.boundSid === sid) {
      route.boundSid = undefined;
    }
    // 旧 token 登记：被断开的手机凭其回连时收 4006（而非 4004），展示正确的断开提示。
    if (session.sessionToken) {
      (session.disconnectedTokens ??= []).push(session.sessionToken);
      if (session.disconnectedTokens.length > 4) {
        session.disconnectedTokens.splice(0, session.disconnectedTokens.length - 4);
      }
    }
    session.state = "pending";
    session.sessionToken = undefined;
    session.tokenExpiresAt = undefined;
    session.disconnectedAt = undefined;
    session.readyDeadline = undefined;
    session.streamId = undefined;
    session.supersededTokens = undefined;
    session.closedByKick = undefined;
    session.tokenRemintedAfterBound = undefined;
    return effects;
  }

  /**
   * 手机 WSS 升级校验（/ws/phone 与 /ws/signal 共用）。
   * ready（首次）/ bound（同 token 自顶替）/ grace（断线重连）均放行。
   */
  checkPhoneUpgrade(sid: string, token: string): PhoneUpgradeCheck {
    const session = this.sessions.get(sid);
    if (
      !session ||
      !session.sessionToken ||
      session.sessionToken !== token ||
      (session.state !== "ready" && session.state !== "bound" && session.state !== "grace")
    ) {
      // 被顶替设备的重连裁决（spec §21.6）：P2P 旧设备收不到 close 4001（中转管道已退役），
      // 拆除直连后会凭原 token 回来重试，这里返回 4001 让手机展示「已在其他设备登录」而非「已失效」。
      if (
        session &&
        (session.supersededTokens?.includes(token) === true ||
          (session.closedByKick === true && session.sessionToken === token))
      ) {
        return { ok: false, closeCode: 4001, reason: "superseded" };
      }
      // 桌面主动断开的手机（spec §21.2）：P2P 下 close_phone 触达不了，凭旧 token 回连时
      // 返回 4006，手机展示「已在电脑端断开连接」并停止自动重连。
      if (session?.disconnectedTokens?.includes(token) === true) {
        return { ok: false, closeCode: 4006, reason: "desktop-disconnected" };
      }
      return { ok: false, closeCode: 4004, reason: "session-expired" };
    }
    if (session.tokenExpiresAt != null && this.now() > session.tokenExpiresAt) {
      session.state = "closed";
      return { ok: false, closeCode: 4004, reason: "session-expired" };
    }
    return { ok: true, session };
  }

  // ==========================================================================
  // 手机管道绑定与踢人（spec §6.4，单设备，后连踢前连）
  // ==========================================================================

  /**
   * 手机数据管道就绪：分配 streamId、执行踢人、通知桌面 stream_open。
   * 前置：checkPhoneUpgrade 已通过且桌面在线（桌面离线时 server 直接 4002，不进这里）。
   */
  bindPhoneStream(mid: string, sid: string): { effects: RelayEffect[]; streamId: number } {
    const route = this.desktopRoutes.get(mid);
    const session = this.sessions.get(sid);
    if (!route || !session) {
      return { effects: [], streamId: -1 };
    }
    const effects: RelayEffect[] = [];
    // 踢人对象 = 在线管道或 grace/P2P 中仍占名额的旧会话（后连踢前连，单设备）。
    const previousSid = route.activeStream?.sid ?? route.boundSid;
    if (previousSid && previousSid !== sid) {
      const oldSession = this.sessions.get(previousSid);
      if (oldSession && oldSession.state !== "closed") {
        oldSession.closedByKick = true;
        effects.push({ kind: "close_phone", sid: previousSid, code: 4001, reason: "superseded" });
        // P2P 已升级的旧会话没有活跃中转流，但桌面仍需 stream_close(kicked) 才能拆除
        // 残留 RTC（spec §21.9）；streamId 用会话上保留的旧值兜底。
        const kickedStreamId = route.activeStream?.streamId ?? oldSession.streamId;
        if (kickedStreamId != null) {
          effects.push({
            kind: "stream_close",
            streamId: kickedStreamId,
            sid: previousSid,
            reason: "kicked",
          });
        }
        if (route.activeStream) {
          route.activeStream = undefined;
        }
        oldSession.state = "closed";
      }
    } else if (route.activeStream && route.activeStream.sid === sid) {
      // 同 token 自顶替：等价自踢，关掉旧手机管道（旧 WS 多半已半死）。
      effects.push({ kind: "close_phone", sid, code: 4001, reason: "superseded" });
    } else if (!route.activeStream && route.boundSid === sid && session.tokenRemintedAfterBound) {
      // 同 sid 新设备转移（spec §21.9）：旧设备已升级 P2P（中转流退役），token 重铸后的
      // 首次升级按踢人处理——通知桌面拆残留 RTC，避免 busy 拒绝新设备的协商。
      session.tokenRemintedAfterBound = false;
      if (session.streamId != null) {
        effects.push({
          kind: "stream_close",
          streamId: session.streamId,
          sid,
          reason: "kicked",
        });
      }
    }
    const streamId = route.nextStreamId;
    route.nextStreamId += 1;
    route.activeStream = { streamId, sid };
    route.boundSid = sid;
    session.state = "bound";
    session.streamId = streamId;
    session.disconnectedAt = undefined;
    session.readyDeadline = undefined;
    session.tokenExpiresAt = this.now() + REMOTE_CONTROL_SESSION_TTL_MS;
    effects.push({ kind: "stream_open", streamId, sid });
    return { effects, streamId };
  }

  /** 手机数据管道断开 → grace，通知桌面 stream_close(lost)；单设备名额保留至 grace 结束。 */
  phoneDisconnected(sid: string): RelayEffect[] {
    const session = this.sessions.get(sid);
    if (!session || session.state === "closed") {
      return [];
    }
    const effects: RelayEffect[] = [];
    const route = this.desktopRoutes.get(session.mid);
    if (route?.activeStream?.sid === sid) {
      effects.push({
        kind: "stream_close",
        streamId: route.activeStream.streamId,
        sid,
        reason: "lost",
      });
      route.activeStream = undefined;
      route.boundSid = sid;
    }
    session.state = "grace";
    session.disconnectedAt = this.now();
    return effects;
  }

  /** 手机升级 P2P 后主动关闭中转管道：桌面侧旧 stream 关闭，会话保持（手机仍在线）。 */
  phonePromotedToP2p(sid: string): RelayEffect[] {
    const session = this.sessions.get(sid);
    if (!session || session.state === "closed") {
      return [];
    }
    const route = this.desktopRoutes.get(session.mid);
    if (route?.activeStream?.sid === sid) {
      const streamId = route.activeStream.streamId;
      route.activeStream = undefined;
      route.boundSid = sid;
      return [{ kind: "stream_close", streamId, sid, reason: "p2p_promoted" }];
    }
    return [];
  }

  /** 桌面主动 revoke：手机收 4004，会话作废并释放单设备名额。 */
  revokeSession(sid: string): RelayEffect[] {
    const session = this.sessions.get(sid);
    if (!session || session.state === "closed") {
      return [];
    }
    const effects: RelayEffect[] = [{ kind: "close_phone", sid, code: 4004, reason: "revoked" }];
    const route = this.desktopRoutes.get(session.mid);
    if (route?.activeStream?.sid === sid) {
      effects.push({
        kind: "stream_close",
        streamId: route.activeStream.streamId,
        sid,
        reason: "phone_stop",
      });
      route.activeStream = undefined;
    }
    if (route?.boundSid === sid) {
      route.boundSid = undefined;
    }
    if (route?.activeTicketSid === sid) {
      route.activeTicketSid = undefined;
    }
    session.state = "closed";
    return effects;
  }

  /** 桌面长连断开：全部手机管道 4002，会话进入 grace 等桌面回来。 */
  desktopDisconnected(mid: string): RelayEffect[] {
    const route = this.desktopRoutes.get(mid);
    const effects: RelayEffect[] = [];
    if (route?.activeStream) {
      const { sid } = route.activeStream;
      effects.push({ kind: "close_phone", sid, code: 4002, reason: "desktop-offline" });
      route.activeStream = undefined;
      const session = this.sessions.get(sid);
      if (session && session.state === "bound") {
        session.state = "grace";
        session.disconnectedAt = this.now();
      }
    }
    return effects;
  }

  /** 数据流量触达：滑动续期会话凭证。 */
  touchSession(sid: string): void {
    const session = this.sessions.get(sid);
    if (session && session.state !== "closed") {
      session.tokenExpiresAt = this.now() + REMOTE_CONTROL_SESSION_TTL_MS;
    }
  }

  /**
   * 周期清扫：票据 TTL / ready 超时 / grace 超时 / 会话凭证自然过期。
   * grace 与 token 过期的桌面侧收尾（UI 回 pending）由桌面自己的定时器完成，
   * relay 不补发通知——桌面在 stream_close(lost) 时已拿到唯一所需事实。
   */
  sweep(): RelayEffect[] {
    const now = this.now();
    const effects: RelayEffect[] = [];
    for (const session of this.sessions.values()) {
      // 长效票据（persistent）无 TTL，仅被替换/撤销/断开后作废（spec §21.1）。
      if (
        !session.persistent &&
        session.state === "pending" &&
        now > session.issuedAt + REMOTE_CONTROL_TICKET_TTL_MS
      ) {
        session.state = "closed";
        session.closedAt = now;
        effects.push({ kind: "session_invalid", sid: session.sid, reason: "expired" });
        continue;
      }
      if (
        session.state === "ready" &&
        session.readyDeadline != null &&
        now > session.readyDeadline
      ) {
        // 手机 60s 内未升级 WS：token 作废，票据回退 pending 仍可再次 bind（spec §21.1 多次使用）。
        session.state = "pending";
        session.sessionToken = undefined;
        session.tokenExpiresAt = undefined;
        session.readyDeadline = undefined;
        continue;
      }
      if (
        session.state === "grace" &&
        session.disconnectedAt != null &&
        now > session.disconnectedAt + REMOTE_CONTROL_SESSION_IDLE_TTL_MS
      ) {
        session.state = "closed";
        session.closedAt = now;
        continue;
      }
      if (
        (session.state === "bound" || session.state === "ready") &&
        session.tokenExpiresAt != null &&
        now > session.tokenExpiresAt
      ) {
        const route = this.desktopRoutes.get(session.mid);
        if (route?.activeStream?.sid === session.sid) {
          effects.push({
            kind: "stream_close",
            streamId: route.activeStream.streamId,
            sid: session.sid,
            reason: "lost",
          });
          route.activeStream = undefined;
        }
        effects.push({
          kind: "close_phone",
          sid: session.sid,
          code: 4004,
          reason: "session-expired",
        });
        session.state = "closed";
      }
    }
    // closed 会话保留一个窗口期（排查/幂等去重）后物理删除，防长稳运行内存累积。
    for (const [sid, session] of this.sessions) {
      if (session.state !== "closed") {
        continue;
      }
      if (session.closedAt == null) {
        session.closedAt = this.now();
        continue;
      }
      if (this.now() > session.closedAt + CLOSED_SESSION_RETENTION_MS) {
        this.sessions.delete(sid);
      }
    }
    return effects;
  }
}
