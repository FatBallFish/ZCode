import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("Windows 打包关闭 Node Inspector，保留 Agent 所需的 RunAsNode", async () => {
  vi.stubEnv("MIKIKO_TARGET_OS", "win32");
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses?.enableNodeCliInspectArguments).toBe(false);
  expect(config.electronFuses?.runAsNode).toBeUndefined();
});

it.each(["darwin", "linux"])("%s 保留现有 fuse 配置", async (platform) => {
  vi.stubEnv("MIKIKO_TARGET_OS", platform);
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses).toBeUndefined();
});

it.each(["arm64", "x64"])("mac %s 随包包含独立 Mikiko 原生后端与网关", async (arch) => {
  vi.stubEnv("MIKIKO_TARGET_OS", "darwin");
  vi.stubEnv("MIKIKO_TARGET_ARCH", arch);
  const { default: config } = await import("../electron-builder.config.js");
  expect(config.extraResources).toContainEqual({
    from: `bundled-tools/darwin-${arch}/mikiko-computer-use`,
    to: "computer-use",
    filter: ["**/*"],
  });
  expect(
    config.mac.signIgnore.some((pattern: string) =>
      new RegExp(pattern).test(
        "/Mikiko.app/Contents/Resources/computer-use/Mikiko Computer Use.app",
      ),
    ),
  ).toBe(true);
});

it.each(["win32", "linux"])("%s 不携带 macOS Mikiko 原生资源", async (platform) => {
  vi.stubEnv("MIKIKO_TARGET_OS", platform);
  const { default: config } = await import("../electron-builder.config.js");
  expect(config.extraResources.some((entry: { to: string }) => entry.to === "computer-use")).toBe(
    false,
  );
});
