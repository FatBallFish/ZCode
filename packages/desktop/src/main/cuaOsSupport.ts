import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

declare const __MIKIKO_COMPUTER_USE_AVAILABLE__: boolean;

// 承诺地板 = max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA 二进制 minos 11.0)。
// 2026-08 事故：地板检查缺位时，低版本 macOS 用户只看到授权反复无响应
// （真因是 LaunchServices -10825 拒启 Helper）。
export const CUA_MINIMUM_MACOS_VERSION = "12.0";
// 地板与上游 zcode-cua helperAppBundle.ts 的 Info.plist LSMinimumSystemVersion(12.0) 联动，
// bump 任一侧必须同步其余常量。
const CUA_MINIMUM_DARWIN_MAJOR = 21; // Darwin major - 9 = macOS major（21↔12, 22↔13）

export function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
  computerUseAvailable = typeof __MIKIKO_COMPUTER_USE_AVAILABLE__ !== "undefined" &&
    __MIKIKO_COMPUTER_USE_AVAILABLE__,
): CuaOsSupport {
  // OS 满足要求不代表当前构建包含真实 producer；占位包授权/重试无法恢复 Helper。
  if (!computerUseAvailable) return { kind: "build-unavailable" };
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}

/** 新后端的地板与资源独立于官方producer编译标记，不能借旧12.0合同报告支持。 */
export function resolveMikikoComputerUseSupport(
  platform: string,
  darwinRelease: string,
  available: boolean,
): CuaOsSupport {
  // Windows/Linux 走上游 open-computer-use 的实验性 Go 运行时（UIA/AT-SPI 桥），
  // 无 macOS 版本地板概念；资源缺失时仍报告 build-unavailable 而非实验支持。
  if (platform === "win32" || platform === "linux") {
    return available
      ? { kind: "supported", backend: "mikiko-native", experimental: true }
      : { kind: "build-unavailable" };
  }
  if (platform !== "darwin") return { kind: "not-applicable" };
  if (!available) return { kind: "build-unavailable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major)) return { kind: "build-unavailable" };
  if (major < 23)
    return {
      kind: "macos-below-minimum",
      minimumMacOs: "14.0",
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  return { kind: "supported", backend: "mikiko-native" };
}
