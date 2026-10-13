import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ChromiumHardwareAccelerationApp {
  disableHardwareAcceleration(): void;
  commandLine: {
    appendSwitch(switchName: string): void;
  };
}

export function resolveChromiumHardwareAccelerationSettingsFile(
  homePath: string = homedir(),
): string {
  return join(homePath, ".mikiko", "v2", "setting.json");
}

export function extractBootstrapChromiumHardwareAccelerationEnabled(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return true;
  }

  const enabled = (
    rawValue as {
      desktopChromiumHardwareAccelerationEnabled?: unknown;
    }
  ).desktopChromiumHardwareAccelerationEnabled;
  return typeof enabled === "boolean" ? enabled : true;
}

function readBootstrapChromiumSettingsFileRaw(
  settingsFile: string = resolveChromiumHardwareAccelerationSettingsFile(),
): unknown {
  if (!existsSync(settingsFile)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(settingsFile, "utf-8"));
  } catch {
    return undefined;
  }
}

export function applyEarlyChromiumHardwareAccelerationBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings?: unknown,
): boolean {
  const raw = rawSettings === undefined ? readBootstrapChromiumSettingsFileRaw() : rawSettings;
  const enabled =
    raw === undefined ? true : extractBootstrapChromiumHardwareAccelerationEnabled(raw);
  if (!enabled) {
    // Electron 只能在 app ready 前关闭 Chromium 硬件加速。
    // 因此设置页保存后必须在下一次 main 进程最早期读取并应用，不能等到 whenReady。
    app.disableHardwareAcceleration();
  }
  applyEarlyChromiumHighPerformanceGpuBootstrap(app, raw);
  return enabled;
}

/**
 * 高性能 GPU 优先（2026-10-12，Windows 混合显卡客户反馈）：NVIDIA 面板在 Optimus
 * 笔记本上按程序指定「高性能 NVIDIA 处理器」常报「拒绝方案 无法应用选定的设置」
 * ——混合显卡系统的按应用 GPU 偏好由 Windows 图形设置接管，驱动面板不再有效。
 * 应用侧等价开关是 Chromium 的 force_high_performance_gpu（与硬件加速同为
 * app ready 前生效，需重启）。默认关闭（省电/核显路径），仅用户显式开启。
 */
export function applyEarlyChromiumHighPerformanceGpuBootstrap(
  app: ChromiumHardwareAccelerationApp,
  rawSettings: unknown,
): boolean {
  const enabled = rawValueIsHighPerformanceGpuEnabled(rawSettings);
  if (enabled) {
    app.commandLine.appendSwitch("force_high_performance_gpu");
  }
  return enabled;
}

function rawValueIsHighPerformanceGpuEnabled(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return false;
  }
  const enabled = (rawValue as { desktopChromiumHighPerformanceGpuEnabled?: unknown })
    .desktopChromiumHighPerformanceGpuEnabled;
  return enabled === true;
}
