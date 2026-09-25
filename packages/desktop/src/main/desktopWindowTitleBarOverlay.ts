import { PlatformChannels } from "@zcode/shared";
import { resolveDesktopZoomFactorForLevel } from "./desktopZoom.js";

/**
 * win32 原生 titleBarOverlay 同步（登记制）。独立成 electron-free 模块的原因与
 * remoteControl/rtc/macWindowSurfaces.ts 相同：本文件被 packages/desktop/test 的
 * 纯 node 单测直接加载，不能引入 electron（其 CJS 入口在 node 下不提供具名导出，
 * 模块级 import 即失败）。
 *
 * 修复依据（2026-09-25 Windows 真机）：RTC 隐藏工具窗口加载共享 preload（about:blank），
 * preload 启动即发 WindowControlsOverlayReady，main 的 handler 对发送方窗口调
 * syncWindowControlsOverlayForZoomLevel；win32 分支里既非自绘窗控、创建时又未带
 * titleBarOverlay:true 的窗口会落到 setTitleBarOverlay——Electron 对未启用 overlay
 * 的窗口同步抛 TypeError "Titlebar overlay is not enabled"，异常发生在 ipcMain.on
 * 回调内无人捕获，直接崩主进程（手机连接成功瞬间弹
 * "A JavaScript error occurred in the main process"）。
 *
 * Electron 41 没有 getTitleBarOverlay() 查询 API，窗口能力只能由创建方登记：
 * 主窗口走自绘窗控分支（customWindowsControls，desktopWindowButtonPosition.ts）；
 * 创建参数带 titleBarOverlay:true 的窗口（当前仅更新状态窗）在本模块登记；
 * 其余工具窗口（远控 RTC）一律跳过。
 */

/** 具备原生 titleBarOverlay 的窗口最小面（结构化接口，便于单测注入假窗口）。 */
export interface NativeWindowsTitleBarOverlayWindow {
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
  webContents: { send(channel: string, payload: unknown): void };
}

export const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
export const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;

const nativeOverlayWindows = new WeakSet<object>();

/** 仅创建参数带 titleBarOverlay:true 的窗口可登记（当前唯一调用方：更新状态窗）。 */
export function registerNativeWindowsTitleBarOverlay(win: object): void {
  nativeOverlayWindows.add(win);
}

export function hasNativeWindowsTitleBarOverlay(win: object): boolean {
  return nativeOverlayWindows.has(win);
}

export function resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel: number) {
  return Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * resolveDesktopZoomFactorForLevel(zoomLevel));
}

export function resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  return {
    // 原生按钮宽度不随页面缩放；固定 CSS 边距只适用于下面的自绘窗控分支。
    rightPaddingPx: Math.round(
      WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / resolveDesktopZoomFactorForLevel(zoomLevel),
    ),
    titleBarHeightPx: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

export function buildWindowsTitleBarOverlayForZoomLevel(
  zoomLevel: number,
  theme: "light" | "dark",
) {
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#f5f5f5" : "#1f1f1f",
    height: resolveWindowsTitleBarOverlayHeightForZoomLevel(zoomLevel),
  };
}

/**
 * 对登记过的窗口同步原生 overlay 尺寸并下发安全区 metrics；未登记窗口直接跳过
 * （对它调 setTitleBarOverlay 会抛，见文件头修复依据）。
 */
export function syncNativeWindowsTitleBarOverlay(
  win: NativeWindowsTitleBarOverlayWindow,
  zoomLevel: number,
  theme: "light" | "dark",
): void {
  if (!nativeOverlayWindows.has(win)) {
    return;
  }
  win.setTitleBarOverlay(buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, theme));
  win.webContents.send(
    PlatformChannels.WindowControlsOverlayChanged,
    resolveWindowsWindowControlsOverlayMetricsForZoomLevel(zoomLevel),
  );
}
