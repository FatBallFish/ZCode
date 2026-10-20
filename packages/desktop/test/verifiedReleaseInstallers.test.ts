import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const modulePath = "../scripts/macos-notarization.mjs";
const expected = { sourceRunId: "123", commit: "a".repeat(40), ref: "v1.1.3", arch: "arm64" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "verified-installers-"));
  dirs.push(dir);
  const { fileDigest, verifyReleaseInstallers } = await import(modulePath);
  const files: Record<string, unknown> = {};
  for (const extension of ["dmg", "zip"]) {
    const name = `Mikiko-1.1.3-mac-arm64.${extension}`;
    await writeFile(join(dir, name), `verified ${extension}`);
    files[name] = await fileDigest(join(dir, name));
  }
  const proofPath = join(dir, "release-verification.json");
  const proof = {
    schema: 1,
    ...expected,
    version: "1.1.3",
    submissionId: "accepted-id",
    status: "Accepted",
    appStapled: true,
    dmgStapled: true,
    zipPayloadVerified: true,
    files,
  };
  await writeFile(proofPath, JSON.stringify(proof));
  return { dir, proofPath, proof, verifyReleaseInstallers };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("仅发布恢复的已验收Mac安装包", () => {
  it("匹配原始run、架构和最终哈希才允许继续", async () => {
    const { dir, verifyReleaseInstallers } = await fixture();
    expect((await verifyReleaseInstallers(dir, expected)).status).toBe("Accepted");
  });
  it.each(["sourceRunId", "commit", "ref", "arch"])("拒绝其他%s的proof", async (key) => {
    const { dir, verifyReleaseInstallers } = await fixture();
    await expect(verifyReleaseInstallers(dir, { ...expected, [key]: "other" })).rejects.toThrow(
      /identity/i,
    );
  });
  it.each(["status", "appStapled", "dmgStapled", "zipPayloadVerified"])(
    "缺少验收条件%s时拒绝",
    async (key) => {
      const { dir, proofPath, proof, verifyReleaseInstallers } = await fixture();
      await writeFile(proofPath, JSON.stringify({ ...proof, [key]: false }));
      await expect(verifyReleaseInstallers(dir, expected)).rejects.toThrow(/verif|Accepted/i);
    },
  );
  it("拒绝损坏的最终文件和缺少ZIP的proof", async () => {
    const { dir, proofPath, proof, verifyReleaseInstallers } = await fixture();
    const name = "Mikiko-1.1.3-mac-arm64.dmg";
    const original = await readFile(join(dir, name));
    await writeFile(join(dir, name), "corrupt");
    await expect(verifyReleaseInstallers(dir, expected)).rejects.toThrow(/hash/i);
    await writeFile(join(dir, name), original);
    delete proof.files["Mikiko-1.1.3-mac-arm64.zip"];
    await writeFile(proofPath, JSON.stringify(proof));
    await expect(verifyReleaseInstallers(dir, expected)).rejects.toThrow(/file|ZIP/i);
  });
});
