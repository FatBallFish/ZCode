import assert from "node:assert/strict";
import test from "node:test";
import {
  hideRtcWindowFromMacDesktopSurfaces,
  type MacDesktopSurfaceWindow,
} from "../../src/main/remoteControl/rtc/macWindowSurfaces.js";

/**
 * macOS 桌面表面隐藏守卫单测（spec §9.1）：setHiddenInMissionControl 是 macOS 专属
 * API，非 darwin 平台未守卫调用会同步抛 TypeError 崩溃主进程
 * （2026-09-25 Linux amd64 真机回归：手机点「开始连接」即弹主进程错误框）。
 */

interface FakeWindow {
  missionControlCalls: number;
  readyToShowListeners: Array<() => void>;
}

function createFakeWindow(): FakeWindow & MacDesktopSurfaceWindow {
  const win: FakeWindow & MacDesktopSurfaceWindow = {
    missionControlCalls: 0,
    readyToShowListeners: [],
    setHiddenInMissionControl() {
      win.missionControlCalls += 1;
    },
    once(_event, listener) {
      win.readyToShowListeners.push(listener);
    },
  };
  return win;
}

function withPlatform<T>(platform: string, run: () => T): T {
  // process.platform 原生只读，defineProperty 是 node 测试的标准改写手法；
  // 恢复时写回原描述符而非仅值，避免污染同进程的其它测试。
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

test("linux/win32 平台不调用 setHiddenInMissionControl（回归：点开始连接即崩主进程）", () => {
  for (const platform of ["linux", "win32", "freebsd"]) {
    withPlatform(platform, () => {
      const win = createFakeWindow();
      hideRtcWindowFromMacDesktopSurfaces(win);
      assert.equal(win.missionControlCalls, 0, `${platform} 不应调用 macOS 专属 API`);
      assert.equal(win.readyToShowListeners.length, 0, `${platform} 不应注册 ready-to-show 补调`);
    });
  }
});

test("darwin 平台立即隐藏一次，ready-to-show 后再补一次", () => {
  withPlatform("darwin", () => {
    const win = createFakeWindow();
    hideRtcWindowFromMacDesktopSurfaces(win);
    assert.equal(win.missionControlCalls, 1);
    assert.equal(win.readyToShowListeners.length, 1);
    win.readyToShowListeners[0]!();
    assert.equal(win.missionControlCalls, 2);
  });
});
