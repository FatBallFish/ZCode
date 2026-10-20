import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";
const fetchReleaseCatalog = vi.fn();
vi.mock("../src/runtime/releaseDownload.js", () => ({
  fetchReleaseCatalog,
  fetchReleaseJson: vi.fn(),
  ReleaseDownloader: class {},
}));
const { prepareOnlineUpdate } = await import("../src/runtime/updatePreparation.js");

describe("Mikiko CLI 自建更新目录默认值", () => {
  beforeEach(() => {
    fetchReleaseCatalog.mockReset().mockResolvedValue({ schemaVersion: 1, releases: [] });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("未设置时读取自建默认目录", async () => {
    vi.stubEnv("MIKIKO_SERVER_RELEASE_MANIFEST_URL", undefined);
    await expect(
      prepareOnlineUpdate(resolveServerLayout("/tmp/mikiko-update-source-default")),
    ).rejects.toThrow(/No release for target/u);
    expect(fetchReleaseCatalog).toHaveBeenCalledWith(
      "https://agent-dl.mikiko.ai/mikiko/server/catalog.json",
    );
  });
  it("显式空字符串保留离线pending模式", async () => {
    vi.stubEnv("MIKIKO_SERVER_RELEASE_MANIFEST_URL", "");
    await expect(
      prepareOnlineUpdate(resolveServerLayout("/tmp/mikiko-update-source-offline")),
    ).rejects.toThrow(/release source is not configured/u);
    expect(fetchReleaseCatalog).not.toHaveBeenCalled();
  });
  it("显式配置继续覆盖默认目录", async () => {
    vi.stubEnv("MIKIKO_SERVER_RELEASE_MANIFEST_URL", "http://127.0.0.1:9876/catalog.json");
    await expect(
      prepareOnlineUpdate(resolveServerLayout("/tmp/mikiko-update-source-override")),
    ).rejects.toThrow(/No release for target/u);
    expect(fetchReleaseCatalog).toHaveBeenCalledWith("http://127.0.0.1:9876/catalog.json");
  });
});
