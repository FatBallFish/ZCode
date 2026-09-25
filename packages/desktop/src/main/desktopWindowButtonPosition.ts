import { nativeTheme, type BrowserWindow, type Point } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { resolveDesktopZoomFactorForLevel } from "./desktopZoom.js";
import {
  syncNativeWindowsTitleBarOverlay,
  WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX,
} from "./desktopWindowTitleBarOverlay.js";

export const MACOS_TRAFFIC_LIGHT_BASE_POSITION = { x: 22, y: 23 } as const;
const MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX = 96;
const MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN = 1.5;
const MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX = 4;
const customWindowsControls = new WeakSet<BrowserWindow>();

export function registerCustomWindowsControls(window: BrowserWindow) {
  customWindowsControls.add(window);
}

export function hasCustomWindowsControls(window: BrowserWindow) {
  return customWindowsControls.has(window);
}

function resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel: number): Point {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const resolveVerticalPosition = (base: number) =>
    Math.max(
      MACOS_TRAFFIC_LIGHT_MIN_POSITION_PX,
      Math.round(base + (base * zoomFactor - base) * MACOS_TRAFFIC_LIGHT_POSITION_MOVEMENT_GAIN),
    );
  return {
    x: MACOS_TRAFFIC_LIGHT_BASE_POSITION.x,
    y: resolveVerticalPosition(MACOS_TRAFFIC_LIGHT_BASE_POSITION.y),
  };
}

function resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel: number) {
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const buttonPosition = resolveMacOSWindowButtonPositionForZoomLevel(zoomLevel);
  return {
    buttonPosition,
    metrics: {
      leftPaddingPx: Math.round(MACOS_TRAFFIC_LIGHT_BASE_LEFT_PADDING_PX / zoomFactor),
    },
  };
}

export function syncWindowControlsOverlayForZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  zoomLevel: number,
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (process.platform === "darwin") {
    const { buttonPosition, metrics } =
      resolveMacOSWindowControlsOverlayMetricsForZoomLevel(zoomLevel);
    // 页面缩放会改变 renderer 顶部栏的视觉尺寸，但 macOS 原生红绿灯不会随页面缩放。
    // 每次缩放后按同一 zoom factor 调整原生按钮纵向位置；横向位置先保持系统初始值，避免和固定宽度安全区重复补偿。
    // 红绿灯自身宽度不随页面 zoom 变化，所以 renderer 的 CSS padding 要按 zoom factor 反向补偿。
    targetWindow.setWindowButtonPosition(buttonPosition);
    targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, metrics);
    return;
  }

  if (process.platform === "win32") {
    if (hasCustomWindowsControls(targetWindow)) {
      // 自绘按钮随页面缩放，安全区也使用固定 CSS 像素，不能再反向补偿原生按钮宽度。
      targetWindow.webContents.send(PlatformChannels.WindowControlsOverlayChanged, {
        rightPaddingPx: WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX,
      });
      return;
    }
    // Windows titleBarOverlay 的原生窗控不会跟 renderer 页面缩放自动同步，需要同时同步
    // overlay.height 并把 renderer 的右侧安全区按 zoomFactor 反向补偿，让两侧布局同频缩放
    //（尺寸推导见 desktopWindowTitleBarOverlay.ts）。
    // 同步走登记制：只有创建时带 titleBarOverlay:true 并登记过的窗口（更新状态窗）才会
    // 调 setTitleBarOverlay；未登记的工具窗口（远控 RTC about:blank 窗）直接跳过，否则
    // Electron 对未启用 overlay 的窗口同步抛 "Titlebar overlay is not enabled"，崩主进程
    //（2026-09-25 Windows 真机：手机连接成功瞬间弹主进程错误框，根因链见模块文件头）。
    syncNativeWindowsTitleBarOverlay(
      targetWindow,
      zoomLevel,
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    );
  }
}
