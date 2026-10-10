/**
 * 桌面宠物窗口的专用 preload（specs/desktop/desktop-pet.md）。
 *
 * 只暴露宠物页真正需要的通信面，不复用主窗口 preload——宠物是个透明置顶无焦点小窗，
 * 攻击面越小越好（与 cuaPermissionPanel 同款约束）。拖拽是锚点式：页面只上报
 * 开始/结束，移动由 main 以 60Hz 锚点重算驱动（renderer screenX/Y 在混合 DPI
 * 多屏下与 main 坐标系不一致，不参与移动）。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_PET_DRAG_DIRECTION_CHANNEL,
  DESKTOP_PET_STATE_CHANNEL,
  PlatformChannels,
  type ActivePetView,
  type DesktopPetDragDirectionEvent,
  type DesktopPetStateEvent,
  type DesktopPetSteadyState,
} from "@zcode/shared";

contextBridge.exposeInMainWorld("desktopPet", {
  /** 挂载时读取当前宠物（清单 + petpack:// 图集地址）；未启用/非法返回 null。 */
  getActive: (): Promise<{ view: ActivePetView; state: DesktopPetSteadyState } | null> =>
    ipcRenderer.invoke(PlatformChannels.PetGetActive),
  /** 开始拖拽：main 记录光标/窗口锚点并接管移动。 */
  dragStart: () => ipcRenderer.send(PlatformChannels.PetDragStart),
  /** 结束拖拽：返回 main 侧累计位移（px），页面据此判定点击。 */
  dragEnd: (): Promise<{ movedPx: number }> => ipcRenderer.invoke(PlatformChannels.PetDragEnd),
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
  /** main 推送的拖拽方向（迟滞判定后仅在切换时发送）。 */
  onDragDirection: (callback: (event: DesktopPetDragDirectionEvent) => void) => {
    const listener = (_event: unknown, payload: DesktopPetDragDirectionEvent) => callback(payload);
    ipcRenderer.on(DESKTOP_PET_DRAG_DIRECTION_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DESKTOP_PET_DRAG_DIRECTION_CHANNEL, listener);
  },
});
