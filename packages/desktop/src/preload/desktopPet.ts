/**
 * 桌面宠物窗口的专用 preload（specs/desktop/desktop-pet.md）。
 *
 * 只暴露宠物页真正需要的四件事，不复用主窗口 preload——宠物是个透明置顶无焦点小窗，
 * 攻击面越小越好（与 cuaPermissionPanel 同款约束）。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_PET_STATE_CHANNEL,
  PlatformChannels,
  type ActivePetView,
  type DesktopPetStateEvent,
  type DesktopPetSteadyState,
} from "@zcode/shared";

contextBridge.exposeInMainWorld("desktopPet", {
  /** 挂载时读取当前宠物（清单 + petpack:// 图集地址）；未启用/非法返回 null。 */
  getActive: (): Promise<{ view: ActivePetView; state: DesktopPetSteadyState } | null> =>
    ipcRenderer.invoke(PlatformChannels.PetGetActive),
  /** 拖拽增量；main 侧负责 setPosition 与屏幕边界夹取。 */
  dragMove: (delta: { dx: number; dy: number }) =>
    ipcRenderer.send(PlatformChannels.PetDragMove, delta),
  /** 右键菜单（main 在光标处弹出）。 */
  contextMenu: () => ipcRenderer.send(PlatformChannels.PetContextMenu),
  /** 双击宠物：唤起 App 主窗口。 */
  openApp: () => ipcRenderer.send(PlatformChannels.PetOpenApp),
  /** main 推送的宠物状态（agent 运行态 / 启用问候）。 */
  onState: (callback: (event: DesktopPetStateEvent) => void) => {
    const listener = (_event: unknown, payload: DesktopPetStateEvent) => callback(payload);
    ipcRenderer.on(DESKTOP_PET_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DESKTOP_PET_STATE_CHANNEL, listener);
  },
});
