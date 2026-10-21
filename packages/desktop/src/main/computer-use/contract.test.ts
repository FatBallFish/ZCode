import { describe, expect, it } from "vitest";
import {
  resolveMikikoComputerUseResources,
  mikikoComputerUseResourceEnv,
  areMikikoComputerUseResourcesAvailable,
  mikikoComputerUsePermissionSettingsUrl,
} from "./contract.js";
import { resolveMikikoComputerUseSupport } from "../cuaOsSupport.js";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Mikiko Computer Use production resources", () => {
  it("checks executable/server resources asynchronously and maps only the two permission panes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mikiko-runtime-resources-"));
    try {
      const appPath = join(root, "Mikiko Computer Use.app");
      const binary = join(appPath, "Contents", "MacOS", "mikiko-computer-use");
      const server = join(root, "production-server.mjs");
      await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
      await writeFile(binary, "fixture");
      await chmod(binary, 0o700);
      await writeFile(server, "fixture");
      expect(await areMikikoComputerUseResourcesAvailable({ appPath, binary, server })).toBe(true);
      await rm(server);
      expect(await areMikikoComputerUseResourcesAvailable({ appPath, binary, server })).toBe(false);
      expect(await areMikikoComputerUseResourcesAvailable(undefined)).toBe(false);
      expect(mikikoComputerUsePermissionSettingsUrl("accessibility")).toContain(
        "Privacy_Accessibility",
      );
      expect(mikikoComputerUsePermissionSettingsUrl("screen_recording")).toContain(
        "Privacy_ScreenCapture",
      );
      expect(() => mikikoComputerUsePermissionSettingsUrl("other")).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const appPath = "/resources/computer-use/Mikiko Computer Use.app";
  const binary = `${appPath}/Contents/MacOS/mikiko-computer-use`;
  const server = "/resources/computer-use/production-server.mjs";
  const options = {
    platform: "darwin",
    arch: "arm64",
    isPackaged: true,
    resourcesPath: "/resources",
    workspaceRoot: "/repo",
    exists: () => true,
  };
  it("uses fixed packaged resources despite inherited path overrides", () => {
    const result = resolveMikikoComputerUseResources({
      ...options,
      env: {
        MIKIKO_COMPUTER_USE_BINARY: "/other/binary",
        MIKIKO_COMPUTER_USE_SERVER: "/other/server",
      },
    });
    expect(result).toEqual({ appPath, binary, server });
    expect(mikikoComputerUseResourceEnv(result)).toMatchObject({
      MIKIKO_COMPUTER_USE_BINARY: binary,
      MIKIKO_COMPUTER_USE_APP_PATH: appPath,
      MIKIKO_COMPUTER_USE_SERVER: server,
      MIKIKO_COMPUTER_USE_MODE: "production",
    });
  });
  it("fails closed for missing resources and unsupported platforms", () => {
    expect(
      resolveMikikoComputerUseResources({ ...options, exists: (path) => path !== server }),
    ).toBeUndefined();
    expect(resolveMikikoComputerUseResources({ ...options, platform: "win32" })).toBeUndefined();
    expect(resolveMikikoComputerUseResources({ ...options, platform: "linux" })).toBeUndefined();
  });
  it("resolves the production development cache independently of the old preview app", () => {
    const result = resolveMikikoComputerUseResources({ ...options, isPackaged: false, env: {} });
    expect(result?.appPath).toBe(
      "/repo/.cache/mikiko-computer-use/production/arm64/release/Mikiko Computer Use.app",
    );
    expect(result?.server).toBe(
      "/repo/.cache/mikiko-computer-use/production/production-server.mjs",
    );
  });
  it("advertises this backend only for an available local macOS14+ runtime", () => {
    expect(resolveMikikoComputerUseSupport("darwin", "23.0.0", true)).toEqual({
      kind: "supported",
      backend: "mikiko-native",
    });
    expect(resolveMikikoComputerUseSupport("darwin", "22.0.0", true)).toEqual({
      kind: "macos-below-minimum",
      minimumMacOs: "14.0",
      currentMacOs: "13",
    });
    expect(resolveMikikoComputerUseSupport("darwin", "23.0.0", false)).toEqual({
      kind: "build-unavailable",
    });
    expect(resolveMikikoComputerUseSupport("linux", "", true)).toEqual({ kind: "not-applicable" });
  });
});
