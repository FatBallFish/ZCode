import { describe, expect, it } from "vitest";
import { sourceServerReleaseArchiveSchema } from "../src/source-server/release.js";

describe("Mikiko Source Server release identity", () => {
  const archive = {
    target: "linux-arm64",
    version: "1.1.3",
    sha256: "a".repeat(64),
    sizeBytes: 64,
    urls: ["https://agent-dl.mikiko.ai/server/1.1.3/mikiko-server-linux-arm64.tar.gz"],
  };
  it("accepts the Mikiko archive name produced by the self-hosted packager", () => {
    expect(
      sourceServerReleaseArchiveSchema.safeParse({
        ...archive,
        fileName: "mikiko-server-linux-arm64.tar.gz",
      }).success,
    ).toBe(true);
  });
  it("rejects a different product archive instead of weakening integrity checks", () => {
    expect(
      sourceServerReleaseArchiveSchema.safeParse({
        ...archive,
        fileName: "zcode-server-linux-arm64.tar.gz",
      }).success,
    ).toBe(false);
  });
});
