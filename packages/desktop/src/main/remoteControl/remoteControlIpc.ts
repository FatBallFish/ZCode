import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { DesktopRemoteControlState } from "@zcode/shared/remote-control";
import type { RemoteControlService } from "./service.js";

/**
 * 手机远控 IPC（spec §7.5/§21.10）：invoke 四个动作 + Main → Renderer 状态推送。
 * 状态唯一所有者是 Main 的 remoteControlService，renderer 只读镜像。
 *
 * `enabled` 只反映平台能力（桌面恒接线 → true；Web 未实现时 renderer 侧拿不到方法），
 * 不再受配置文件影响：relay 端点缺失 / enabled=false 由 state.disabledReason 表达
 * （`unconfigured` / `config`），入口恒展示，UI 按归因适配扫码直连区域。
 */

const UNCONFIGURED_STATE: DesktopRemoteControlState = {
  phase: "disabled",
  disabledReason: "unconfigured",
};

export function registerRemoteControlIpc(options: { service: RemoteControlService | null }): void {
  const { service } = options;
  ipcMain.handle(PlatformChannels.RemoteControlGetState, () => ({
    state: service?.getState() ?? UNCONFIGURED_STATE,
    enabled: true,
  }));
  ipcMain.handle(PlatformChannels.RemoteControlStart, () => ({
    state: service?.start() ?? UNCONFIGURED_STATE,
  }));
  ipcMain.handle(PlatformChannels.RemoteControlStop, () => ({
    state: service?.stop() ?? UNCONFIGURED_STATE,
  }));
  ipcMain.handle(PlatformChannels.RemoteControlRefreshTicket, () => ({
    state: service?.refreshTicket() ?? UNCONFIGURED_STATE,
  }));
  ipcMain.handle(PlatformChannels.RemoteControlDisconnect, () => ({
    state: service?.disconnect() ?? UNCONFIGURED_STATE,
  }));
  ipcMain.handle(PlatformChannels.RemoteControlSetAutoRefresh, (_event, enabled: unknown) => ({
    state: service?.setAutoRefresh(enabled === true) ?? UNCONFIGURED_STATE,
  }));
}
