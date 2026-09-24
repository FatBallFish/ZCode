import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopRemoteControlState } from "@zcode/shared/remote-control";
import { usePlatform } from "@/hooks/usePlatform.js";

/**
 * 手机远控 UI 状态镜像（spec §7.5）。
 * Main 的 remoteControlService 是唯一所有者；本 hook 只做只读镜像 + 动作转发，
 * 不在 renderer 侧保存第二份可写状态。平台未实现（Web / relay 未配置）时返回 null，
 * 调用方据此隐藏入口。
 *
 * 动作 pending 态与防抖（spec §21.9）：start/stop/disconnect/refreshTicket 走 relay
 * 网络往返耗时较长，执行期间暴露 pendingAction 供按钮展示 spinner 并禁用；
 * 同一动作 pending 中重复调用直接忽略（防抖）。解除条件：IPC promise 落定，
 * 或状态推送到达目标相位（start→非 disabled / stop→disabled），先到先清，
 * 防止单一通道丢失导致永久卡 pending。
 */
export type RemoteControlPendingAction = "start" | "stop" | "disconnect" | "refreshTicket";

export function useRemoteControl(): {
  available: boolean;
  state: DesktopRemoteControlState | null;
  pendingAction: RemoteControlPendingAction | null;
  start: () => void;
  stop: () => void;
  disconnect: () => void;
  refreshTicket: () => void;
  setAutoRefresh: (enabled: boolean) => void;
} {
  const platform = usePlatform();
  const methodsPresent =
    platform.getRemoteControlState != null &&
    platform.startRemoteControl != null &&
    platform.stopRemoteControl != null &&
    platform.onRemoteControlStateChanged != null;
  // 默认不可用（fail-closed）：由 GetState 的 enabled 确认后再放行——
  // relay 未配置时桌面 IPC 恒注册但 enabled=false，入口必须隐藏。
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<DesktopRemoteControlState | null>(null);
  const [pendingAction, setPendingAction] = useState<RemoteControlPendingAction | null>(null);
  const pendingActionRef = useRef<RemoteControlPendingAction | null>(null);

  const clearPendingAction = useCallback((action: RemoteControlPendingAction) => {
    if (pendingActionRef.current === action) {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }, []);

  useEffect(() => {
    if (
      !methodsPresent ||
      !platform.getRemoteControlState ||
      !platform.onRemoteControlStateChanged
    ) {
      return;
    }
    let disposed = false;
    void platform
      .getRemoteControlState()
      .then((payload) => {
        if (!disposed) {
          setAvailable(payload.enabled);
          setState(payload.state);
        }
      })
      .catch(() => {
        // 拉取失败按不可用处理（fail-closed）。
      });
    const dispose = platform.onRemoteControlStateChanged((next) => {
      setState(next);
      // 状态推送先于 IPC promise 到达目标相位时提前解除 pending（先到先清）。
      const action = pendingActionRef.current;
      if (action === "start" && next.phase !== "disabled") {
        clearPendingAction("start");
      } else if (action === "stop" && next.phase === "disabled") {
        clearPendingAction("stop");
      }
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [methodsPresent, platform, clearPendingAction]);

  const runAction = useCallback(
    (action: RemoteControlPendingAction, invoke: () => Promise<DesktopRemoteControlState>) => {
      // 防抖：任一动作 pending 中忽略后续调用，避免连点造成重复启停/重复签发票据。
      if (pendingActionRef.current != null) {
        return;
      }
      pendingActionRef.current = action;
      setPendingAction(action);
      void invoke()
        .then((next) => setState(next))
        .catch(() => {
          // 动作失败时状态以 Main 推送为准，这里只负责解除 pending。
        })
        .finally(() => clearPendingAction(action));
    },
    [clearPendingAction],
  );

  const start = useCallback(() => {
    if (platform.startRemoteControl) {
      runAction("start", () => platform.startRemoteControl!());
    }
  }, [platform, runAction]);

  const stop = useCallback(() => {
    if (platform.stopRemoteControl) {
      runAction("stop", () => platform.stopRemoteControl!());
    }
  }, [platform, runAction]);

  const disconnect = useCallback(() => {
    if (platform.disconnectRemoteControl) {
      runAction("disconnect", () => platform.disconnectRemoteControl!());
    }
  }, [platform, runAction]);

  const setAutoRefresh = useCallback(
    (enabled: boolean) => {
      void platform.setRemoteControlAutoRefresh?.(enabled).then((state) => setState(state));
    },
    [platform],
  );

  const refreshTicket = useCallback(() => {
    if (platform.refreshRemoteControlTicket) {
      runAction("refreshTicket", () => platform.refreshRemoteControlTicket!());
    }
  }, [platform, runAction]);

  return {
    available,
    state,
    pendingAction,
    start,
    stop,
    disconnect,
    refreshTicket,
    setAutoRefresh,
  };
}
