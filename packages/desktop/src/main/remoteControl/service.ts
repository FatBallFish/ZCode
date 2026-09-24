/* eslint-disable max-lines -- 远控状态机（票据/stream/attachment/重连）是单一所有者闭环，拆散会造成跨文件共享可变闭包状态。 */
import {
  REMOTE_CONTROL_SESSION_IDLE_TTL_MS,
  isRemoteControlActiveState,
  type DesktopRemoteControlState,
  type RemoteControlDesktopFrame,
  type RemoteControlRtcSignal,
} from "@zcode/shared/remote-control";
import { RelayConnection, type RelayTransportFactory } from "./relayConnection.js";
import { createMobileStreamPump, type MobileStreamPump, type PumpPort } from "./streamPump.js";

/**
 * 手机远控 Main 侧编排器（spec §7.1）：远控状态的唯一所有者。
 *
 * 事件顺序契约：
 *   start → 注册 → issue → pending(二维码) → 手机 bind → stream_open → attach(踢人 supersede)
 *         → connected → 手机断开 stream_close(lost) → waiting(5min) → 超时重签 → pending
 *   relay 断开 → 指数退避重连 → register_ok：pending 期间不重签（旧票据 TTL 内仍有效），
 *   waiting 超过 grace 才重签；connected/waiting 期间手机凭 sessionToken 重连旧 sid 即恢复。
 */

export interface RemoteControlAttachedPort {
  attachmentId: string;
  port: PumpPort;
}

export interface RemoteControlDeviceIdentity {
  /** 确保 mid + deviceToken 可用（必要时向 relay 注册换发）。 */
  ensureCredentials(): Promise<{ mid: string; token: string }>;
  /** 清除本地 deviceToken（relay 重启/token 失效后由下次 ensureCredentials 重新注册）。 */
  clearCredentials(): Promise<void>;
  readonly deviceName: string;
  readonly appVersion: string;
}

export interface RemoteControlServiceTimers {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: RemoteControlServiceTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** 票据到期后留一点缓冲再重签，避免与 relay sweep 竞态抖动。 */
const TICKET_REFRESH_MARGIN_MS = 2000;

interface ActiveMobileStream {
  streamId: number;
  attachmentId: string;
  webContentsId: number;
  pump: MobileStreamPump;
}

/** v2 P2P 委托：控制器持有窗口与 p2p attachment 生命周期，service 只查询状态与请求拆除。 */
export interface RemoteControlRtcDelegate {
  isP2pActive(): boolean;
  /**
   * 拆除 P2P（隐藏窗口 + DataChannel）：被顶替/桌面主动断开时由 service 调用；
   * 带 reason 时先经 DataChannel 发 0x02 应用层通知，手机秒级感知（spec §21.2/§21.6）。
   */
  disposeP2p?(reason?: "desktop-disconnected" | "superseded"): void;
}

export function createRemoteControlService(deps: {
  relayWsUrl: string;
  transportFactory: RelayTransportFactory;
  device: RemoteControlDeviceIdentity;
  attachPort(webContentsId: number): RemoteControlAttachedPort;
  detachPort(webContentsId: number, attachmentId: string, reason: string): void;
  activeWebContentsId(): number | null;
  broadcastState(state: DesktopRemoteControlState): void;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  timers?: RemoteControlServiceTimers;
}) {
  const timers = deps.timers ?? defaultTimers;

  let phase: DesktopRemoteControlState = { phase: "disabled" };
  let started = false;
  let connection: RelayConnection | null = null;
  let registered = false;
  let needTicket = false;
  let reconnectAttempt = 0;
  let currentSid: string | null = null;
  /** 最近一次票据（disconnect 后凭它回到 pending 展示同一二维码，spec §21.2）。 */
  let lastTicket: { sid: string; url: string; expiresAt: number | null } | null = null;
  /** 最近一次在线手机 UA（waiting 设备卡片展示，spec §21.8）。 */
  let lastConnectedUa: string | null = null;
  /** 自动刷新开关（spec §21.1.5）：开=短时票据到期自动重签；关=长效票据直到手动刷新。 */
  let autoRefresh = false;
  /** disconnect 已发起：relay 回 stream_close(phone_stop) 时据此回 pending 而非 waiting。 */
  let pendingDisconnect = false;
  let activeStream: ActiveMobileStream | null = null;
  let reconnectHandle: unknown = null;
  let ticketExpiryHandle: unknown = null;
  let waitingHandle: unknown = null;

  function setPhase(next: DesktopRemoteControlState): void {
    phase = next;
    deps.broadcastState(next);
  }

  function clearTimer(handle: unknown): void {
    if (handle != null) {
      timers.clearTimeout(handle);
    }
  }

  function requestTicket(): void {
    needTicket = true;
    if (registered) {
      connection?.sendIssueSession({ persistent: !autoRefresh });
    } else {
      void ensureConnection();
    }
  }

  /** waiting 兜底：超 grace 未恢复则重签票据回 pending（所有进入 waiting 的路径共用）。 */
  function armWaitingTimer(): void {
    clearTimer(waitingHandle);
    waitingHandle = timers.setTimeout(() => {
      waitingHandle = null;
      if (phase.phase === "waiting") {
        requestTicket();
      }
    }, REMOTE_CONTROL_SESSION_IDLE_TTL_MS);
  }

  function teardownAttachment(reason: string): void {
    if (!activeStream) {
      return;
    }
    const stream = activeStream;
    activeStream = null;
    stream.pump.dispose();
    deps.detachPort(stream.webContentsId, stream.attachmentId, reason);
  }

  function scheduleReconnect(): void {
    if (!started || connection) {
      return;
    }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    reconnectAttempt += 1;
    clearTimer(reconnectHandle);
    reconnectHandle = timers.setTimeout(() => {
      reconnectHandle = null;
      void ensureConnection();
    }, delay);
    deps.logger.info("[remote-control] relay reconnect scheduled", {
      delayMs: delay,
      attempt: reconnectAttempt,
    });
  }

  async function ensureConnection(): Promise<void> {
    if (!started || connection) {
      return;
    }
    let credentials: { mid: string; token: string };
    try {
      credentials = await deps.device.ensureCredentials();
    } catch (error) {
      deps.logger.error("[remote-control] device credentials unavailable", {
        error: String(error),
      });
      // 注册失败按一次重连计，退避后重试。
      scheduleReconnect();
      return;
    }
    if (!started) {
      return;
    }
    const url = `${deps.relayWsUrl}?mid=${encodeURIComponent(credentials.mid)}&token=${encodeURIComponent(credentials.token)}`;
    const conn = new RelayConnection(url, deps.transportFactory, {
      onFrame: (frame) => handleFrame(frame),
      onBinary: (streamId, payload) => handleBinary(streamId, payload),
      onClosed: (code, reason) => handleTransportClosed(code, reason),
    });
    connection = conn;
    conn.connect();
    conn.sendRegister({
      mid: credentials.mid,
      token: credentials.token,
      name: deps.device.deviceName,
      appVersion: deps.device.appVersion,
    });
  }

  function handleFrame(frame: RemoteControlDesktopFrame): void {
    switch (frame.type) {
      case "register_ok": {
        registered = true;
        reconnectAttempt = 0;
        if (needTicket) {
          needTicket = false;
          connection?.sendIssueSession({ persistent: !autoRefresh });
          return;
        }
        // waiting 但已超 grace：旧 sid 在 relay 侧大概率已被清扫，重签。
        if (
          phase.phase === "waiting" &&
          timers.now() - phase.since >= REMOTE_CONTROL_SESSION_IDLE_TTL_MS
        ) {
          connection?.sendIssueSession({ persistent: !autoRefresh });
        }
        return;
      }
      case "session_issued": {
        currentSid = frame.sid;
        lastTicket = { sid: frame.sid, url: frame.url, expiresAt: frame.expiresAt };
        const ticket = { ...lastTicket, autoRefresh };
        clearTimer(ticketExpiryHandle);
        ticketExpiryHandle = null;
        if (frame.expiresAt != null) {
          // 仅短时票据（自动刷新模式）存在到期重签；长效票据无到期（spec §21.1）。
          ticketExpiryHandle = timers.setTimeout(
            () => {
              ticketExpiryHandle = null;
              if (phase.phase === "pending" && phase.sid === frame.sid) {
                requestTicket();
              }
            },
            Math.max(0, frame.expiresAt - timers.now()) + TICKET_REFRESH_MARGIN_MS,
          );
        }
        // 已连接/等待重连期间重签（手动刷新或连接中到期）：保持原相位，只更新票据快照，
        // 弹窗二维码常驻且不因换码打断状态展示（spec §21.8）。
        if (phase.phase === "connected") {
          setPhase({ ...phase, ticket });
          deps.logger.info("[remote-control] ticket issued", { sid: frame.sid });
          return;
        }
        if (phase.phase === "waiting") {
          setPhase({
            phase: "waiting",
            since: phase.since,
            deviceUa: lastConnectedUa ?? undefined,
            ticket,
          });
          deps.logger.info("[remote-control] ticket issued", { sid: frame.sid });
          return;
        }
        setPhase({ phase: "pending", ...ticket });
        deps.logger.info("[remote-control] ticket issued", { sid: frame.sid });
        return;
      }
      case "session_invalid": {
        // superseded = 桌面自己发起的票据替换的回执噪音：若处理会与 in-flight 的
        // session_issued 竞态（invalid 先到、currentSid 尚未推进）触发无限重签，必须忽略。
        if (frame.reason === "superseded") {
          return;
        }
        // 只认当前 sid：票据到期自刷新后，relay 对旧 sid 的迟到通知不得触发二次重签。
        if (frame.sid !== currentSid) {
          return;
        }
        requestTicket();
        return;
      }
      case "stream_open": {
        handleStreamOpen(frame.streamId, frame.phone.ua);
        return;
      }
      case "stream_close": {
        handleStreamClose(frame.streamId, frame.reason, frame.sid);
        return;
      }
      case "rtc_signal": {
        // v2 P2P：Main 只透传给 RTC 载体，不解析信令语义。
        rtcSignalHandler?.(frame.streamId, frame.data);
        return;
      }
      case "error": {
        deps.logger.warn("[remote-control] relay error frame", {
          code: frame.code,
          message: frame.message,
        });
        return;
      }
      default: {
        return;
      }
    }
  }

  function handleStreamOpen(streamId: number, phoneUa: string): void {
    // 踢人双保险（spec §7.4）：relay 已踢旧手机，本地先拆旧 attachment 再挂新。
    if (activeStream && activeStream.streamId !== streamId) {
      teardownAttachment("superseded");
    }
    if (activeStream?.streamId === streamId) {
      return; // 重复 stream_open 幂等忽略。
    }
    const webContentsId = deps.activeWebContentsId();
    if (webContentsId == null) {
      connection?.sendStreamCloseNotify(streamId);
      enterWaiting("attach-unavailable");
      return;
    }
    let attached: RemoteControlAttachedPort;
    try {
      attached = deps.attachPort(webContentsId);
    } catch (error) {
      deps.logger.warn("[remote-control] attach failed", { error: String(error) });
      connection?.sendStreamCloseNotify(streamId);
      enterWaiting("attach-unavailable");
      return;
    }
    const pump = createMobileStreamPump({
      port: attached.port,
      sendWireBytes: (framed) => connection?.sendStreamBinary(streamId, framed),
      notifyClosed: () => {
        connection?.sendStreamCloseNotify(streamId);
        teardownAttachment("host-port-closed");
      },
      onInvalidFrame: (reason) => {
        deps.logger.warn("[remote-control] invalid frame from phone pipe", { streamId, reason });
        teardownAttachment("invalid-frame");
        connection?.sendStreamCloseNotify(streamId);
      },
    });
    activeStream = { streamId, attachmentId: attached.attachmentId, webContentsId, pump };
    connection?.sendStreamAccepted(streamId);
    clearTimer(waitingHandle);
    waitingHandle = null;
    lastConnectedUa = phoneUa;
    setPhase({
      phase: "connected",
      detail: { streamId, phoneUa, transport: "relay", since: timers.now() },
      ticket: lastTicket ? { ...lastTicket, autoRefresh } : undefined,
    });
    deps.logger.info("[remote-control] phone stream attached", { streamId, webContentsId });
  }

  function enterWaiting(reason: string): void {
    armWaitingTimer();
    setPhase({
      phase: "waiting",
      since: timers.now(),
      deviceUa: lastConnectedUa ?? undefined,
      ticket: lastTicket ? { ...lastTicket, autoRefresh } : undefined,
    });
    deps.logger.info("[remote-control] phone stream closed", { reason });
  }

  function handleStreamClose(streamId: number, reason: string, sid?: string): void {
    if (activeStream?.streamId !== streamId) {
      // P2P 会话被顶替（spec §21.6/§21.9）：被踢手机的中转管道已退役（4005 或跨票据顶替），
      // relay 的 close_phone(4001) 触达不了它，只能由桌面拆除 DataChannel；否则残留的 RTC
      // 会让控制器对所有后续 p2p_request 回 busy（2026-09-24 真机定位）。
      // 单设备语义下：P2P 存活 + 任意流被踢且不在活跃中转 → 被踢的就是 P2P 那台设备。
      if (reason === "kicked" && !activeStream && rtcDelegate?.isP2pActive() === true) {
        rtcDelegate.disposeP2p?.("superseded");
        enterWaiting("p2p-superseded");
        deps.logger.info("[remote-control] p2p session superseded, rtc torn down", {
          sid,
          currentSid,
        });
        return;
      }
      // P2P 场景的桌面主动断开回执（spec §21.2）：relay 对无活跃中转流的 disconnect_session
      // 也会补发 stream_close(phone_stop)；RTC 已在 disconnect() 中直接拆除，这里只收敛相位。
      if (
        pendingDisconnect &&
        reason === "phone_stop" &&
        !activeStream &&
        phase.phase !== "pending"
      ) {
        pendingDisconnect = false;
        clearTimer(waitingHandle);
        waitingHandle = null;
        if (lastTicket) {
          setPhase({ phase: "pending", ...lastTicket, autoRefresh });
        }
      }
      return; // 迟到的旧管道事件，幂等忽略。
    }
    teardownAttachment(`relay-${reason}`);
    if (!started) {
      return;
    }
    if (reason === "p2p_promoted") {
      // 手机已升级 P2P：relay 管道关闭是预期行为，拆除 relay attachment 后保持 connected。
      // 不依赖 isP2pActive() 时序——4005 可能先于控制器处理 dc-open 到达（spec §21.7）。
      if (phase.phase === "connected") {
        setPhase({ ...phase, detail: { ...phase.detail, transport: "p2p" } });
      }
      return;
    }
    if (pendingDisconnect && reason === "phone_stop") {
      // disconnect_session 的 relay 回执（spec §21.2）：回 pending 展示同一票据，不进 waiting。
      pendingDisconnect = false;
      clearTimer(waitingHandle);
      waitingHandle = null;
      if (lastTicket) {
        setPhase({ phase: "pending", ...lastTicket, autoRefresh });
        return;
      }
    }
    enterWaiting(reason);
  }

  function handleBinary(streamId: number, payload: Uint8Array): void {
    if (activeStream?.streamId !== streamId) {
      return;
    }
    if (!activeStream.pump.handleWireBytes(payload)) {
      // 帧非法已由 onInvalidFrame 回调处理；这里只兜底清理本地状态。
      teardownAttachment("invalid-frame");
    }
  }

  function handleTransportClosed(code: number, reason: string): void {
    const neverRegistered = !registered;
    connection = null;
    registered = false;
    teardownAttachment("relay-transport-closed");
    deps.logger.info("[remote-control] relay transport closed", { code, reason });
    if (!started) {
      return;
    }
    if (neverRegistered) {
      neverRegisteredStreak += 1;
      if (neverRegisteredStreak >= 2) {
        // 连续两轮从未 register_ok 即断开：大概率 relay 重启导致 deviceToken 失效，
        // 清凭证后重连会走重新注册（spec §6.7）。首轮不清，容忍普通网络瞬断。
        neverRegisteredStreak = 0;
        void deps.device.clearCredentials().catch(() => undefined);
      }
    } else {
      neverRegisteredStreak = 0;
    }
    // pending 期间 relay 断开：relay 重启会丢失全部会话（无盘），长效票据随之作废且
    // relay 无法回发 invalid（sid 已不知晓）。统一在重连注册后重签一次（spec §21.1；
    // 「同码可扫」的旧优化随多次使用语义作废，替换由单活票据语义兜底）。
    if (phase.phase === "pending") {
      needTicket = true;
    }
    // connected 掉线转 waiting。
    if (phase.phase === "connected") {
      enterWaiting("relay-transport-closed");
    }
    scheduleReconnect();
  }

  let rtcSignalHandler: ((streamId: number, data: unknown) => void) | null = null;
  let rtcDelegate: RemoteControlRtcDelegate | null = null;
  let neverRegisteredStreak = 0;
  const stopListeners = new Set<() => void>();

  return {
    getState(): DesktopRemoteControlState {
      return phase;
    },
    start(): DesktopRemoteControlState {
      if (isRemoteControlActiveState(phase)) {
        return phase;
      }
      started = true;
      needTicket = true;
      reconnectAttempt = 0;
      void ensureConnection();
      // connecting 是内部瞬态；等 session_issued 再广播 pending，避免 UI 闪烁空态。
      return phase;
    },
    refreshTicket(): DesktopRemoteControlState {
      if (!started) {
        return this.start();
      }
      requestTicket();
      return phase;
    },
    /**
     * 断开当前设备（spec §21.2）：仅踢当前手机会话，功能保持开启；
     * relay 回执后回 pending 展示同一票据（票据可多次 bind，手机可凭原链接重连）。
     */
    disconnect(): DesktopRemoteControlState {
      if (!started) {
        return phase;
      }
      pendingDisconnect = true;
      if (connection && currentSid) {
        try {
          connection.sendDisconnectSession(currentSid);
        } catch {
          // 连接半死时发送失败可接受；本地仍按断开处理。
        }
      }
      // P2P 在线时 relay 的 close_phone(4006) 触达不了手机（中转管道已退役，spec §21.2），
      // 必须由桌面直接拆除 DataChannel——先发应用层通知让手机秒级停止，再拆链。
      if (rtcDelegate?.isP2pActive() === true) {
        rtcDelegate.disposeP2p?.("desktop-disconnected");
      }
      teardownAttachment("desktop-disconnect");
      clearTimer(waitingHandle);
      waitingHandle = null;
      if (lastTicket) {
        setPhase({ phase: "pending", ...lastTicket, autoRefresh });
      } else if (!registered) {
        void ensureConnection();
      }
      return phase;
    },
    /**
     * 自动刷新开关（spec §21.1.5/§21.8）：切换即重签一次。连接中同样生效——
     * relay 对 bound 会话不随票据替换踢人（§21.1.4 修订），session_issued 只更新票据快照。
     */
    setAutoRefresh(enabled: boolean): DesktopRemoteControlState {
      autoRefresh = enabled;
      if (started) {
        requestTicket();
      }
      return phase;
    },
    stop(): DesktopRemoteControlState {
      started = false;
      clearTimer(reconnectHandle);
      clearTimer(ticketExpiryHandle);
      clearTimer(waitingHandle);
      reconnectHandle = null;
      ticketExpiryHandle = null;
      waitingHandle = null;
      teardownAttachment("desktop-stop");
      // v2 P2P：stop 必须连带拆除隐藏 RTC 窗口与 p2p attachment（spec §7.1）。
      for (const listener of stopListeners) {
        try {
          listener();
        } catch {
          // 拆除失败不阻断 stop 主流程。
        }
      }
      if (connection && currentSid) {
        try {
          connection.sendRevokeSession(currentSid);
        } catch {
          // 连接半死时 revoke 失败可接受；relay 断开自会清理。
        }
      }
      connection?.close();
      connection = null;
      registered = false;
      currentSid = null;
      lastTicket = null;
      lastConnectedUa = null;
      pendingDisconnect = false;
      needTicket = false;
      setPhase({ phase: "disabled" });
      return phase;
    },
    dispose(): void {
      this.stop();
      rtcSignalHandler = null;
    },
    /** v2 P2P：注册信令回调（由 RTC 载体接线），仅在服务内部使用。 */
    setRtcSignalHandler(handler: ((streamId: number, data: unknown) => void) | null): void {
      rtcSignalHandler = handler;
    },
    setRtcDelegate(delegate: RemoteControlRtcDelegate | null): void {
      rtcDelegate = delegate;
    },
    /** 注册 stop 监听（如 v2 RTC 控制器的窗口/attachment 拆除）。 */
    onStopped(listener: () => void): () => void {
      stopListeners.add(listener);
      return () => {
        stopListeners.delete(listener);
      };
    },
    /** v2 P2P：transport 徽标切换（relay ↔ p2p），仅更新 connected 展示态。 */
    updateConnectedTransport(transport: "relay" | "p2p"): void {
      if (phase.phase === "connected" && phase.detail.transport !== transport) {
        setPhase({ ...phase, detail: { ...phase.detail, transport } });
        return;
      }
      // 4005 先于 dc-open 到达的竞态：阶段已落 waiting 而 RTC 实际存活上线——恢复 connected。
      if (transport === "p2p" && phase.phase === "waiting" && lastConnectedUa != null) {
        setPhase({
          phase: "connected",
          detail: { streamId: -1, phoneUa: lastConnectedUa, transport: "p2p", since: timers.now() },
          ticket: lastTicket ? { ...lastTicket, autoRefresh } : undefined,
        });
      }
    },
    /**
     * 标记与 relay 版本不兼容（spec §22）：wiring 经 healthz 检出桌面版本低于
     * relay 要求的最低版本时调用；UI 展示 lastError 引导升级。
     */
    markIncompatible(reason: string): DesktopRemoteControlState {
      started = false;
      clearTimer(reconnectHandle);
      clearTimer(ticketExpiryHandle);
      clearTimer(waitingHandle);
      reconnectHandle = null;
      ticketExpiryHandle = null;
      waitingHandle = null;
      teardownAttachment("relay-incompatible");
      for (const listener of stopListeners) {
        try {
          listener();
        } catch {
          // 拆除失败不阻断主流程。
        }
      }
      if (connection && currentSid) {
        try {
          connection.sendRevokeSession(currentSid);
        } catch {
          // 连接半死时 revoke 失败可接受。
        }
      }
      connection?.close();
      connection = null;
      registered = false;
      currentSid = null;
      lastTicket = null;
      pendingDisconnect = false;
      needTicket = false;
      setPhase({ phase: "disabled", lastError: reason });
      return phase;
    },
    /**
     * P2P 会话丢失（dc 断开/RTC 窗口被用户关闭，spec §21.10）：手机未回中转前先转
     * waiting（grace 到期自动重签）；此前只翻传输徽标会让 UI 永远停留在已连接。
     */
    noteP2pLost(): void {
      if (!started) {
        return;
      }
      if (phase.phase === "connected") {
        enterWaiting("p2p-lost");
      }
    },
    /** v2 P2P / 测试用：取当前连接发送信令。 */
    sendRtcSignal(streamId: number, data: RemoteControlRtcSignal): boolean {
      connection?.sendRtcSignal(streamId, data);
      return connection != null;
    },
  };
}

export type RemoteControlService = ReturnType<typeof createRemoteControlService>;
