import { useCallback, useEffect, useState } from "react";
import type { DesktopRemoteControlState } from "@zcode/shared/remote-control";
import { usePlatform } from "@/hooks/usePlatform.js";

/**
 * 手机远控 UI 状态镜像（spec §7.5）。
 * Main 的 remoteControlService 是唯一所有者；本 hook 只做只读镜像 + 动作转发，
 * 不在 renderer 侧保存第二份可写状态。平台未实现（Web / relay 未配置）时返回 null，
 * 调用方据此隐藏入口。
 */
export function useRemoteControl(): {
  available: boolean;
  state: DesktopRemoteControlState | null;
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
    const dispose = platform.onRemoteControlStateChanged((next) => setState(next));
    return () => {
      disposed = true;
      dispose();
    };
  }, [methodsPresent, platform]);

  const start = useCallback(() => {
    void platform.startRemoteControl?.().then((state) => setState(state));
  }, [platform]);

  const stop = useCallback(() => {
    void platform.stopRemoteControl?.().then((state) => setState(state));
  }, [platform]);

  const disconnect = useCallback(() => {
    void platform.disconnectRemoteControl?.().then((state) => setState(state));
  }, [platform]);

  const setAutoRefresh = useCallback(
    (enabled: boolean) => {
      void platform.setRemoteControlAutoRefresh?.(enabled).then((state) => setState(state));
    },
    [platform],
  );

  const refreshTicket = useCallback(() => {
    void platform.refreshRemoteControlTicket?.().then((state) => setState(state));
  }, [platform]);

  return { available, state, start, stop, disconnect, refreshTicket, setAutoRefresh };
}
