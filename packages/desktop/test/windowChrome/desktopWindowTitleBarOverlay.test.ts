import assert from "node:assert/strict";
import test from "node:test";
import {
  registerNativeWindowsTitleBarOverlay,
  syncNativeWindowsTitleBarOverlay,
  type NativeWindowsTitleBarOverlayWindow,
} from "../../src/main/desktopWindowTitleBarOverlay.js";

/**
 * win32 原生 titleBarOverlay 同步登记制单测。修复依据（2026-09-25 Windows 真机）：
 * RTC 隐藏工具窗口加载共享 preload（about:blank），preload 启动即发
 * WindowControlsOverlayReady，main 对发送方窗口调 syncWindowControlsOverlayForZoomLevel；
 * win32 下既非自绘窗控、又未启用原生 overlay 的窗口落到 setTitleBarOverlay 时
 * Electron 同步抛 TypeError "Titlebar overlay is not enabled"，ipcMain.on 内未捕获
 * 即崩主进程（手机连接成功瞬间弹 "A JavaScript error occurred in the main process"）。
 */

interface FakeWindow {
  overlayCalls: Array<{ color: string; symbolColor: string; height: number }>;
  sentMetrics: Array<unknown>;
}

function createFakeWindow(): FakeWindow & NativeWindowsTitleBarOverlayWindow {
  const win: FakeWindow & NativeWindowsTitleBarOverlayWindow = {
    overlayCalls: [],
    sentMetrics: [],
    setTitleBarOverlay(options) {
      win.overlayCalls.push(options);
    },
    webContents: {
      send(_channel: string, payload: unknown) {
        win.sentMetrics.push(payload);
      },
    },
  };
  return win;
}

test("未登记窗口跳过 setTitleBarOverlay（RTC 工具窗回归：修复前必抛 TypeError 崩主进程）", () => {
  const win = createFakeWindow();
  syncNativeWindowsTitleBarOverlay(win, 0, "light");
  assert.equal(win.overlayCalls.length, 0);
  assert.equal(win.sentMetrics.length, 0);
});

test("登记窗口按 zoom 档位同步 overlay 尺寸并下发安全区 metrics（更新状态窗路径）", () => {
  const win = createFakeWindow();
  registerNativeWindowsTitleBarOverlay(win);
  syncNativeWindowsTitleBarOverlay(win, 0, "dark");
  assert.equal(win.overlayCalls.length, 1);
  assert.equal(win.overlayCalls[0]?.symbolColor, "#f5f5f5");
  assert.equal(win.overlayCalls[0]?.height, 48);
  assert.deepEqual(win.sentMetrics, [{ rightPaddingPx: 136, titleBarHeightPx: 48 }]);
});

test("zoom 档位非 0 时 overlay 高度与安全区随 zoomFactor 同频缩放", () => {
  const win = createFakeWindow();
  registerNativeWindowsTitleBarOverlay(win);
  syncNativeWindowsTitleBarOverlay(win, 2, "light");
  const zoomFactor = 1.1 ** 2;
  assert.equal(win.overlayCalls[0]?.height, Math.round(48 * zoomFactor));
  assert.deepEqual(win.sentMetrics, [
    {
      rightPaddingPx: Math.round(136 / zoomFactor),
      titleBarHeightPx: Math.round(48 * zoomFactor),
    },
  ]);
});
