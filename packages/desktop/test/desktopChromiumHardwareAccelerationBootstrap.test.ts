import { describe, expect, it, vi } from "vitest";
import {
  applyEarlyChromiumHardwareAccelerationBootstrap,
  extractBootstrapChromiumHardwareAccelerationEnabled,
} from "../src/main/desktopChromiumHardwareAccelerationBootstrap.js";

function buildMockApp() {
  return {
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  };
}

describe("desktopChromiumHardwareAccelerationBootstrap", () => {
  it("默认开启 Chromium 硬件加速，仅显式 false 关闭", () => {
    expect(extractBootstrapChromiumHardwareAccelerationEnabled(null)).toBe(true);
    expect(extractBootstrapChromiumHardwareAccelerationEnabled({})).toBe(true);
    expect(
      extractBootstrapChromiumHardwareAccelerationEnabled({
        desktopChromiumHardwareAccelerationEnabled: true,
      }),
    ).toBe(true);
    expect(
      extractBootstrapChromiumHardwareAccelerationEnabled({
        desktopChromiumHardwareAccelerationEnabled: false,
      }),
    ).toBe(false);
    expect(
      extractBootstrapChromiumHardwareAccelerationEnabled({
        desktopChromiumHardwareAccelerationEnabled: "false",
      }),
    ).toBe(true);
  });

  it("只在设置显式关闭时调用 Electron disableHardwareAcceleration", () => {
    const app = buildMockApp();

    expect(
      applyEarlyChromiumHardwareAccelerationBootstrap(app, {
        desktopChromiumHardwareAccelerationEnabled: true,
      }),
    ).toBe(true);
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();

    expect(
      applyEarlyChromiumHardwareAccelerationBootstrap(app, {
        desktopChromiumHardwareAccelerationEnabled: false,
      }),
    ).toBe(false);
    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    // 高性能 GPU 默认关闭，不追加 switch。
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it("高性能 GPU 优先仅显式 true 时追加 force_high_performance_gpu", () => {
    const app = buildMockApp();
    applyEarlyChromiumHardwareAccelerationBootstrap(app, {
      desktopChromiumHighPerformanceGpuEnabled: true,
    });
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("force_high_performance_gpu");
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();

    const defaultApp = buildMockApp();
    applyEarlyChromiumHardwareAccelerationBootstrap(defaultApp, {});
    expect(defaultApp.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
