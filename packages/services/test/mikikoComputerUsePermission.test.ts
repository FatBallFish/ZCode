import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMikikoComputerUsePermissionService } from "../src/cua-permission-broker/contract.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mikiko-cua-permission-")));
  roots.push(root);
  const appPath = join(root, "Mikiko Computer Use.app");
  const binary = join(appPath, "Contents", "MacOS", "mikiko-computer-use");
  const server = join(root, "production-server.mjs");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(binary, "fixture");
  await chmod(binary, 0o700);
  await writeFile(server, "fixture");
  const doctor = {
    platform: "macos",
    appAgent: true,
    grantOwnerBundleId: "dev.mikiko.computer-use",
    appPath,
    buildIdentifier: "fixture-build",
    accessibilityTrusted: true,
    screenCaptureGranted: false,
    allGranted: false,
    missingPermissions: ["screen_capture"],
  };
  const env = {
    MIKIKO_COMPUTER_USE_BINARY: binary,
    MIKIKO_COMPUTER_USE_APP_PATH: appPath,
    MIKIKO_COMPUTER_USE_SERVER: server,
  };
  const run = vi.fn(async (_file: string, args: readonly string[]) => ({
    stdout: JSON.stringify(
      args[0] === "restart-agent" ? { restarted: true, permissions: doctor } : doctor,
    ),
  }));
  const isEnabled = vi.fn(() => true);
  const create = (extra = {}) =>
    createMikikoComputerUsePermissionService({
      env,
      platform: "darwin",
      darwinRelease: "23.0.0",
      desktopLocal: true,
      isEnabled,
      run,
      ...extra,
    });
  return { create, run, isEnabled, env, doctor, appPath };
}
describe("Mikiko native permission service", () => {
  it("reads the actual app-agent identity and never turns preflight into a functional probe", async () => {
    const { create, run, appPath } = await fixture();
    await expect(create().getStatus("/workspace")).resolves.toMatchObject({
      available: true,
      backend: "mikiko-native",
      appPath,
      grantOwner: "dev.mikiko.computer-use",
      accessibility: "granted",
      screenRecording: "denied",
      accessibilityProbeOk: false,
      screenCaptureProbeOk: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toEqual(["doctor", "--json"]);
  });
  it("rejects off, remote, non-desktop, low OS and missing resources before starting native", async () => {
    const { create, run, isEnabled } = await fixture();
    for (const extra of [
      { desktopLocal: false },
      { platform: "win32" },
      { darwinRelease: "22.0.0" },
      { darwinRelease: "unknown" },
      { env: {} },
    ]) {
      expect(await create(extra).getStatus("/workspace")).toMatchObject({ available: false });
    }
    expect(
      await create().getStatus("/workspace", "remote:ssh:example.invalid:22:test:/workspace"),
    ).toMatchObject({ available: false });
    isEnabled.mockReturnValue(false);
    expect(await create().getStatus("/workspace")).toMatchObject({ available: false });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects malformed diagnostics and a different permission owner", async () => {
    const { create, run, doctor } = await fixture();
    for (const payload of [
      "not-json",
      JSON.stringify({ ...doctor, appAgent: false }),
      JSON.stringify({ ...doctor, grantOwnerBundleId: "dev.other.app" }),
      JSON.stringify({ ...doctor, appPath: "/different/app" }),
    ]) {
      run.mockResolvedValueOnce({ stdout: payload });
      expect(await create().getStatus("/workspace")).toMatchObject({ available: false });
    }
  });
  it("restarts only through the verified idle-only native API and propagates busy", async () => {
    const { create, run } = await fixture();
    expect(await create().restartHelper("/workspace")).toMatchObject({ ok: true });
    expect(run.mock.calls[0]?.[1]).toEqual(["restart-agent", "--json"]);
    run.mockRejectedValueOnce(
      Object.assign(new Error("native failed"), {
        stdout: JSON.stringify({ restarted: false, error: { code: "controller_busy" } }),
      }),
    );
    expect(await create().restartHelper("/workspace")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/busy/i),
    });
    run.mockRejectedValueOnce(Object.assign(new Error("busy"), { stderr: "busy" }));
    expect(await create().restartHelper("/workspace")).toEqual({
      ok: false,
      reason: "Could not restart Mikiko Computer Use.",
    });
  });
});
