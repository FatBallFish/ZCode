import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureServerInstallOwnership } from "../src/runtime/installationOwnership.js";
import { promoteImmutableReleaseDirectory } from "../src/runtime/immutableRelease.js";
import { createRuntimeManifest, serverRuntimeManifestSchema } from "../src/runtime/manifest.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(directory = ".mikiko", overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mikiko-legacy-metadata-"));
  roots.push(root);
  const layout = resolveServerLayout(join(root, directory, "server"));
  await mkdir(layout.releasesDir, { recursive: true });
  const ownership = {
    product: "zcode-server",
    schemaVersion: 1,
    canonicalServerRoot: await realpath(layout.serverRoot),
    installationId: randomUUID(),
    installedAt: 1,
    ...overrides,
  };
  await writeFile(layout.installFile, JSON.stringify(ownership));
  return { root, layout, ownership };
}

async function legacyRelease(root: string, name: string) {
  const path = join(root, name);
  await mkdir(path);
  await writeFile(
    join(path, "manifest.json"),
    JSON.stringify({
      ...createRuntimeManifest("linux-x64", "1.0.0"),
      product: "zcode-server",
      entrypoints: {
        cli: "runtime/server-cli.js",
        core: "runtime/server-core.js",
        agent: "runtime/zcode.cjs",
      },
    }),
  );
  return path;
}

describe("已安装 Mikiko Server 的 legacy 品牌元数据", () => {
  it("读取旧 ownership 保留安装身份与磁盘字节，后续 ensure 不重建安装", async () => {
    const { layout, ownership } = await fixture();
    const before = await readFile(layout.installFile, "utf8");
    await expect(ensureServerInstallOwnership(layout)).resolves.toEqual({
      ...ownership,
      product: "mikiko-server",
    });
    expect(await readFile(layout.installFile, "utf8")).toBe(before);
  });

  it("读取已有旧 release manifest 后仍按原字节验证 immutable 身份，不改写 legacy 文件", async () => {
    const { root, layout } = await fixture();
    const targetDir = join(layout.releasesDir, "1.0.0-legacy");
    const identity = {
      archiveSha256: "a".repeat(64),
      target: "linux-x64" as const,
      version: "1.0.0",
    };
    await promoteImmutableReleaseDirectory({
      incomingDir: await legacyRelease(root, "first"),
      targetDir,
      identity,
    });
    const before = await readFile(join(targetDir, "manifest.json"), "utf8");
    await expect(
      promoteImmutableReleaseDirectory({
        incomingDir: await legacyRelease(root, "second"),
        targetDir,
        identity,
      }),
    ).resolves.toBeUndefined();
    expect(await readFile(join(targetDir, "manifest.json"), "utf8")).toBe(before);
  });

  it("不把旧官方 .zcode 安装识别为 Mikiko ownership", async () => {
    const { layout } = await fixture(".zcode");
    await expect(ensureServerInstallOwnership(layout)).rejects.toThrow(
      /ownership marker is invalid/u,
    );
  });

  it("不经 .mikiko 符号链接自动认领旧官方安装", async () => {
    const { root, layout } = await fixture(".zcode");
    await symlink(
      join(root, ".zcode"),
      join(root, ".mikiko"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = resolveServerLayout(join(root, ".mikiko", "server"));
    const before = await readFile(layout.installFile, "utf8");
    await expect(ensureServerInstallOwnership(alias)).rejects.toThrow(
      /ownership marker is invalid/u,
    );
    expect(await readFile(layout.installFile, "utf8")).toBe(before);
  });

  it.each([{ product: "other-server" }, { extra: true }, { schemaVersion: 99 }])(
    "拒绝其他产品或非法严格字段 %j",
    async (overrides) => {
      const { layout } = await fixture(".mikiko", overrides);
      await expect(ensureServerInstallOwnership(layout)).rejects.toThrow(
        /ownership marker is invalid/u,
      );
    },
  );

  it("保留 ownership canonical 根校验", async () => {
    const { layout } = await fixture(".mikiko", { canonicalServerRoot: "/unrelated/server" });
    await expect(ensureServerInstallOwnership(layout)).rejects.toThrow(/ownership root mismatch/u);
  });

  it("新发行准入只认 Mikiko，旧 product 不能经网络或 archive schema 进入", () => {
    const manifest = createRuntimeManifest("linux-x64", "1.0.0");
    expect(manifest.product).toBe("mikiko-server");
    expect(serverRuntimeManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      serverRuntimeManifestSchema.safeParse({ ...manifest, product: "zcode-server" }).success,
    ).toBe(false);
  });
});
