/**
 * 宠物会话气泡窗口的 preload（specs/desktop/desktop-pet.md 会话状态气泡）。
 * 只暴露两件事：接收 main 推送的会话摘要、点击行上报跳转——攻击面最小。
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type PetSessionBubblePayload } from "@zcode/shared";

const DESKTOP_PET_BUBBLE_CHANNEL = "zcode:desktop-pet-bubble";

contextBridge.exposeInMainWorld("desktopPetBubble", {
  /** 接收 main 推送的会话摘要（rows + overflowCount）。 */
  onSummaries: (callback: (payload: PetSessionBubblePayload) => void) => {
    const listener = (_event: unknown, payload: PetSessionBubblePayload) => callback(payload);
    ipcRenderer.on(DESKTOP_PET_BUBBLE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DESKTOP_PET_BUBBLE_CHANNEL, listener);
  },
  /** 点击某条会话：main 聚焦主窗口并跳转（复用系统通知点击链路）。 */
  openTask: (summary: unknown) => ipcRenderer.send(PlatformChannels.PetBubbleOpenTask, summary),
  /** 关闭某个终态（完成/失败）会话行：本次运行内不再展示，会话重新运行时自动恢复。 */
  dismissTask: (summary: unknown) =>
    ipcRenderer.send(PlatformChannels.PetBubbleDismissTask, summary),
  /** 清空全部终态会话行（进行中/等待中的行不受影响）。 */
  clearTerminal: () => ipcRenderer.send(PlatformChannels.PetBubbleClearTerminal),
  /** 折叠/展开会话列表：main 联动收缩/恢复窗口高度。 */
  setCollapsed: (collapsed: boolean) =>
    ipcRenderer.send(PlatformChannels.PetBubbleSetCollapsed, collapsed),
});
