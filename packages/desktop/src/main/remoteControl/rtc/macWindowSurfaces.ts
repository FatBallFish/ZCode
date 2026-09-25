/**
 * RTC 工具窗口的 macOS 桌面表面隐藏（spec §9.1）。独立成模块的原因：本文件被
 * packages/desktop/test 的纯 node 单测直接加载，不能引入 electron（其 CJS 入口在
 * node 下不提供 BrowserWindow 具名导出，模块级 import 即失败）。
 */

/** macOS 专属窗口表面隐藏所需的最小窗口面（结构化接口，便于单测注入假窗口）。 */
export interface MacDesktopSurfaceWindow {
  setHiddenInMissionControl(hidden: boolean): void;
  once(event: "ready-to-show", listener: () => void): void;
}

/**
 * 把工具窗口从 macOS 桌面表面（Mission Control / App Exposé / Dock 窗口列表）隐藏。
 * 修复依据（2026-09-25 Linux amd64 真机）：setHiddenInMissionControl 是 macOS 专属
 * API，Linux/Windows 的 BrowserWindow 上不存在该方法——未守卫调用会在窗口创建时
 * 同步抛 TypeError 崩溃主进程（手机点「开始连接」即弹主进程错误框，P2P 协商无法
 * 开始）。非 macOS 平台由创建参数 skipTaskbar:true 负责不进任务栏，无需等效调用。
 */
export function hideRtcWindowFromMacDesktopSurfaces(win: MacDesktopSurfaceWindow): void {
  if (process.platform !== "darwin") {
    return;
  }
  // 该 API 要求窗口 ready 后调用才稳定生效，ready-to-show 再补一次。
  win.setHiddenInMissionControl(true);
  win.once("ready-to-show", () => {
    try {
      win.setHiddenInMissionControl(true);
    } catch {
      // 窗口可能已被销毁。
    }
  });
}
