import { describe, expect, it, vi } from "vitest";
import { resolveStandaloneStatusLaunchAppPath } from "./contract.js";
describe("CUA standalone launch boundary", () => {
  it("installs only an existing bundle and reports missing candidates as unavailable", async () => {
    const ensureInstalled = vi.fn(async (path: string) => `${path}/installed`);
    await expect(
      resolveStandaloneStatusLaunchAppPath({
        env: {},
        bundledAppPath: "/bundle",
        exists: (path) => path === "/bundle",
        ensureInstalled,
      }),
    ).resolves.toBe("/bundle/installed");
    await expect(
      resolveStandaloneStatusLaunchAppPath({
        env: {},
        bundledAppPath: undefined,
        exists: () => false,
        ensureInstalled,
      }),
    ).resolves.toBeNull();
    expect(ensureInstalled).toHaveBeenCalledOnce();
  });
});
