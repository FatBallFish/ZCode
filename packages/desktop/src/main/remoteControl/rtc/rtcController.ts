import type { MessagePortMain } from "electron";
import type {
  RemoteControlRtcCommand,
  RemoteControlRtcEvent,
  RemoteControlRtcSignal,
} from "@zcode/shared/remote-control";
import type { RemoteControlAttachedPort } from "../service.js";

/**
 * v2 P2P 控制器（spec §9.3）：隐藏 RTC 窗口内完成 WebRTC 协商与 DataChannel ↔ 端口桥接，
 * Main 只做编排与信令转发，零数据面工作。
 *
 * 数据面拓扑：手机 DataChannel(MessagePortProtocol 语义，无 13B 帧头) ↔ 窗口内桥接 ↔
 * （转移的 MessagePortMain）↔ Host attachment MessagePortProtocol。
 *
 * 状态机：idle → negotiating → bound(dc-open, 双 attachment 并存至 relay stream_close) → idle；
 * 失败/超时/回退：保持中转，冷却期内拒绝再次协商。
 */

const SIGNAL_BUDGET_MS = 15_000;
const FAILURE_COOLDOWN_MS = 10 * 60_000;
/** P2P 硬上限（spec §21.9）：累计失败达限后本服务生命周期内永久降级中继（stop 重置）。 */
const MAX_TOTAL_FAILURES = 5;

/** 窗口抽象：生产用 BrowserWindow，测试注入内存实现。 */
export interface RtcWindowHandle {
  /** 向窗口注入协商命令；bind-port 时以转移列表携带 MessagePortMain。 */
  sendCommand(command: RemoteControlRtcCommand, transfer?: MessagePortMain[]): void;
  onEvent(listener: (event: RemoteControlRtcEvent) => void): () => void;
  destroy(): void;
}

export interface RtcControllerDeps {
  createWindow(): RtcWindowHandle;
  /** 发信令给手机（经 relay rtc_signal）。 */
  sendSignal(streamId: number, data: RemoteControlRtcSignal): void;
  /** dc-open 后挂新 Host attachment（transport=p2p）。 */
  attachPort(webContentsId: number): RemoteControlAttachedPort;
  detachPort(webContentsId: number, attachmentId: string, reason: string): void;
  activeWebContentsId(): number | null;
  onTransportChanged(transport: "relay" | "p2p"): void;
  /** P2P 会话丢失（dc 断开/窗口被关/失败且曾上线）：service 应回 waiting 等手机回中继（spec §21.10）。 */
  onP2pLost?(): void;
  iceServers: { urls: string[] };
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** 可注入时钟（冷却判定用；测试跨冷却窗口驱动硬上限）。 */
  now?: () => number;
}

export function createRtcController(deps: RtcControllerDeps) {
  const setTimeoutFn = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn =
    deps.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const nowFn = deps.now ?? (() => Date.now());

  let window: RtcWindowHandle | null = null;
  let windowEventsOff: (() => void) | null = null;
  let negotiating = false;
  let budgetTimer: unknown = null;
  let totalFailures = 0;
  let cooldownUntil = 0;
  let currentStreamId: number | null = null;
  let p2pAttachment: { attachmentId: string; webContentsId: number } | null = null;
  let p2pActive = false;

  function ensureWindow(): RtcWindowHandle {
    if (window) {
      return window;
    }
    window = deps.createWindow();
    windowEventsOff = window.onEvent(handleWindowEvent);
    return window;
  }

  function teardownWindow(): void {
    windowEventsOff?.();
    windowEventsOff = null;
    window?.destroy();
    window = null;
  }

  function fail(reason: string): void {
    clearTimeoutFn(budgetTimer);
    budgetTimer = null;
    negotiating = false;
    currentStreamId = null;
    // 在线会话的丢失（手机页面关闭：Chromium 不投递 dc close，只有 ICE 心跳超时才发现）
    // 属会话结束而非协商失败——不计入硬上限、不进冷却，否则会挡住下一台设备的协商（spec §21.10）。
    const sessionWasActive = p2pActive;
    if (!sessionWasActive) {
      totalFailures += 1;
      if (totalFailures < MAX_TOTAL_FAILURES) {
        cooldownUntil = nowFn() + FAILURE_COOLDOWN_MS;
      }
    }
    deps.logger.warn("[remote-control-rtc] negotiation failed", {
      reason,
      totalFailures,
      sessionWasActive,
      maxTotalFailures: MAX_TOTAL_FAILURES,
    });
    if (p2pActive) {
      deps.onP2pLost?.();
      // dc 已开但失败/断开：拆除 p2p attachment，等手机回退中转。
      if (p2pAttachment) {
        deps.detachPort(p2pAttachment.webContentsId, p2pAttachment.attachmentId, "p2p-failed");
        p2pAttachment = null;
      }
      p2pActive = false;
      deps.onTransportChanged("relay");
    }
    teardownWindow();
  }

  function handleWindowEvent(event: RemoteControlRtcEvent): void {
    if (event.type === "offer") {
      if (!negotiating || currentStreamId == null) {
        return;
      }
      deps.logger.info("[remote-control-rtc] offer sent to phone", {
        streamId: currentStreamId,
        sdpBytes: event.sdp?.length ?? 0,
      });
      deps.sendSignal(currentStreamId, { kind: "offer", sdp: event.sdp });
      return;
    }
    if (event.type === "ice") {
      if (currentStreamId != null) {
        deps.sendSignal(currentStreamId, {
          kind: "ice",
          candidate: event.candidate as Record<string, unknown>,
        });
      }
      return;
    }
    if (event.type === "dc-open") {
      clearTimeoutFn(budgetTimer);
      budgetTimer = null;
      negotiating = false;
      totalFailures = 0;
      const webContentsId = deps.activeWebContentsId();
      if (webContentsId == null || !window) {
        fail("no-active-window");
        return;
      }
      try {
        const attached = deps.attachPort(webContentsId);
        p2pAttachment = { attachmentId: attached.attachmentId, webContentsId };
        // 端口转移进窗口，窗口内桥接 dc ↔ port；Host 侧 MessagePortProtocol 直收原始消息。
        window.sendCommand({ type: "bind-port" }, [attached.port as MessagePortMain]);
        p2pActive = true;
        deps.onTransportChanged("p2p");
        deps.logger.info("[remote-control-rtc] p2p data channel bound", { webContentsId });
      } catch (error) {
        deps.logger.warn("[remote-control-rtc] p2p attach failed", { error: String(error) });
        fail("attach-failed");
      }
      return;
    }
    if (event.type === "dc-closed") {
      // dc 断开：拆 p2p attachment；手机会回退中转重连。若手机不回来（页面已关），
      // service 也要转 waiting（此前只翻徽标导致 UI 永远停在已连接，spec §21.10）。
      if (p2pAttachment) {
        deps.detachPort(p2pAttachment.webContentsId, p2pAttachment.attachmentId, "p2p-closed");
        p2pAttachment = null;
      }
      const wasActive = p2pActive;
      p2pActive = false;
      deps.onTransportChanged("relay");
      teardownWindow();
      if (wasActive) {
        deps.onP2pLost?.();
      }
      return;
    }
    if (event.type === "failed") {
      fail(event.reason);
    }
  }

  /** relay 侧信令到达（service 转发）。 */
  function handleSignal(streamId: number, data: RemoteControlRtcSignal): void {
    if (data.kind === "p2p_request") {
      if (totalFailures >= MAX_TOTAL_FAILURES) {
        // 硬上限：本服务生命周期内不再尝试 P2P，直接拒绝（手机侧据此保持中继，spec §21.9）。
        deps.sendSignal(streamId, { kind: "reject", reason: "p2p-disabled" });
        return;
      }
      if (negotiating || p2pActive || nowFn() < cooldownUntil) {
        deps.sendSignal(streamId, { kind: "reject", reason: "busy-or-cooldown" });
        return;
      }
      negotiating = true;
      currentStreamId = streamId;
      const rtcWindow = ensureWindow();
      rtcWindow.sendCommand({ type: "negotiate", iceServers: deps.iceServers });
      clearTimeoutFn(budgetTimer);
      budgetTimer = setTimeoutFn(() => fail("signal-budget-exceeded"), SIGNAL_BUDGET_MS);
      return;
    }
    if (data.kind === "answer" && negotiating && window) {
      deps.logger.info("[remote-control-rtc] answer received", {
        streamId,
        sdpBytes: data.sdp?.length ?? 0,
      });
      window.sendCommand({ type: "answer", sdp: data.sdp });
      return;
    }
    if (data.kind === "ice" && (negotiating || p2pActive) && window) {
      window.sendCommand({ type: "ice", candidate: data.candidate });
      return;
    }
    if (data.kind === "reject") {
      if (negotiating) {
        fail(`phone-rejected:${data.reason}`);
      }
    }
  }

  function hardDispose(): void {
    clearTimeoutFn(budgetTimer);
    budgetTimer = null;
    totalFailures = 0;
    if (p2pAttachment) {
      deps.detachPort(p2pAttachment.webContentsId, p2pAttachment.attachmentId, "dispose");
      p2pAttachment = null;
    }
    p2pActive = false;
    negotiating = false;
    teardownWindow();
  }

  return {
    handleSignal,
    isActive(): boolean {
      return p2pActive;
    },
    isNegotiating(): boolean {
      return negotiating;
    },
    /** 立即硬拆（stop/应用退出路径）。 */
    dispose(): void {
      hardDispose();
    },
    /** 带应用层通知的拆除（spec §21.2）：手机先收到 0x02 控制帧再断链。 */
    disposeWithNotify(reason: "desktop-disconnected" | "superseded"): void {
      if (window && p2pActive) {
        try {
          window.sendCommand({ type: "notify", reason });
        } catch {
          // 发送失败直接硬拆。
          hardDispose();
          return;
        }
        clearTimeoutFn(budgetTimer);
        budgetTimer = setTimeoutFn(() => {
          budgetTimer = null;
          hardDispose();
        }, 250);
        return;
      }
      hardDispose();
    },
  };
}

export type RtcController = ReturnType<typeof createRtcController>;
