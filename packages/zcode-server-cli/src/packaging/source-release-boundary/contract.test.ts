import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  beginSourceServerRemoteReleaseGeneration,
  collectSourceServerRemoteReleaseArchives,
  createComponentArchive,
  hashPaths,
  runPackagingCommand,
} from "./contract.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mikiko-packaging-contract-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("组件身份对输入顺序稳定，同时绑定相对路径与真实内容", async () => {
  const root = await fixture();
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "payload"), Buffer.from([0, 128, 255]));
  await writeFile(join(root, "entry.js"), "hello");
  const first = await hashPaths(root, ["nested", "entry.js"]);
  expect(first).toEqual(await hashPaths(root, ["entry.js", "nested"]));
  expect(first.sizeBytes).toBe(8);
  await rename(join(root, "nested", "payload"), join(root, "nested", "renamed"));
  expect((await hashPaths(root, ["nested", "entry.js"])).sha256).not.toBe(first.sha256);
  await writeFile(join(root, "entry.js"), "HELLO");
  expect((await hashPaths(root, ["nested", "entry.js"])).sha256).not.toBe(first.sha256);
});

it("真实组件归档可解包，返回内容身份且清理临时 staging", async () => {
  const root = await fixture();
  const release = join(root, "release");
  const output = join(root, "output");
  const extracted = join(root, "extracted");
  await mkdir(join(release, "runtime"), { recursive: true });
  await mkdir(extracted);
  const payload = Buffer.from([0, 1, 2, 128, 255]);
  await writeFile(join(release, "runtime", "mikiko.cjs"), payload);
  const identity = await hashPaths(release, ["runtime"]);
  const archive = await createComponentArchive(release, output, "linux-x64", "agent", ["runtime"]);
  expect(archive.sha256).toBe(identity.sha256);
  expect(archive.sizeBytes).toBe(payload.length);
  expect(basename(archive.archivePath)).toBe(`agent-${identity.sha256}.tar.gz`);
  await runPackagingCommand("tar", ["-xzf", archive.archivePath, "-C", extracted], root);
  expect(await readFile(join(extracted, "runtime", "mikiko.cjs"))).toEqual(payload);
  expect(await readdir(join(output, ".components"))).toEqual([]);
});

it("发布描述文件绑定实际字节，缺失目标或新 generation 均撤销旧凭证", async () => {
  const root = await fixture();
  const distReleaseDir = join(root, "dist");
  const versionReleaseDir = join(root, "published");
  const fileName = "mikiko-server-linux-x64.tar.gz";
  const payload = Buffer.from([0, 128, 255, 10]);
  await mkdir(distReleaseDir);
  await writeFile(join(distReleaseDir, fileName), payload);
  const options = { distReleaseDir, versionReleaseDir, version: "3.16.2" };
  const descriptorPath = join(versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  expect(
    await collectSourceServerRemoteReleaseArchives({ ...options, targets: ["linux-x64"] }),
  ).toEqual([join(versionReleaseDir, fileName)]);
  expect(await readFile(join(versionReleaseDir, fileName))).toEqual(payload);
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  expect(descriptor).toMatchObject({
    schemaVersion: 1,
    version: options.version,
    archives: [
      {
        target: "linux-x64",
        fileName,
        sizeBytes: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
        urls: [fileName],
      },
    ],
  });
  await expect(
    collectSourceServerRemoteReleaseArchives({
      ...options,
      targets: ["linux-x64", "linux-arm64"],
    }),
  ).rejects.toThrow("Missing Source Server remote release archive for linux-arm64");
  await expect(readFile(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  await collectSourceServerRemoteReleaseArchives({ ...options, targets: ["linux-x64"] });
  await beginSourceServerRemoteReleaseGeneration(options);
  await expect(readFile(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
});
