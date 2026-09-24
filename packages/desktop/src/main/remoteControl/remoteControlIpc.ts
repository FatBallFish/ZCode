import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { RemoteControlService } from "./service.js";

/**
 * 手机远控 IPC（spec §7.5）：invoke 四个动作 + Main → Renderer 状态推送。
 * 状态唯一所有者是 Main 的 remoteControlService，renderer 只读镜像。
 *
 * service 为 null（relay 端点未配置）时恒注册并以 enabled:false 应答：
 * UI 依 enabled 隐藏入口，且 renderer invoke 不产生 unhandled rejection。
 */
export function registerRemoteControlIpc(options: { service: RemoteControlService | null }): void {
  const { service } = options;
  ipcMain.handle(PlatformChannels.RemoteControlGetState, () => ({
    state: service?.getState() ?? { phase: "disabled" },
    enabled: service != null,
  }));
  ipcMain.handle(PlatformChannels.RemoteControlStart, () => ({
    state: service?.start() ?? { phase: "disabled", lastError: "not-configured" },
  }));
  ipcMain.handle(PlatformChannels.RemoteControlStop, () => ({
    state: service?.stop() ?? { phase: "disabled" },
  }));
  ipcMain.handle(PlatformChannels.RemoteControlRefreshTicket, () => ({
    state: service?.refreshTicket() ?? { phase: "disabled", lastError: "not-configured" },
  }));
  ipcMain.handle(PlatformChannels.RemoteControlDisconnect, () => ({
    state: service?.disconnect() ?? { phase: "disabled", lastError: "not-configured" },
  }));
  ipcMain.handle(PlatformChannels.RemoteControlSetAutoRefresh, (_event, enabled: unknown) => ({
    state: service?.setAutoRefresh(enabled === true) ?? {
      phase: "disabled",
      lastError: "not-configured",
    },
  }));
}
