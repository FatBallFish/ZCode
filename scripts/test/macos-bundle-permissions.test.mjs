import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeMacBundleOwnerWrite,
  assertMacBundleOwnerWrite,
} from "../macos-bundle-permissions.mjs";
const exec = promisify(execFile);
const posix = { skip: process.platform === "win32" };
async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), "mikiko-bundle-permissions-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const mode = async (path) => (await lstat(path)).mode & 0o777;

test(
  "normalization repairs copied readonly resources and preserves source/content/executable bits",
  posix,
  async () =>
    fixture(async (root) => {
      const app = join(root, "Mikiko Computer Use.app"),
        source = join(root, "upstream-license");
      await mkdir(join(app, "Contents/Resources"), { recursive: true });
      await mkdir(join(app, "Contents/MacOS"));
      await writeFile(source, "Synthetic upstream license\n");
      await chmod(source, 0o444);
      const license = join(app, "Contents/Resources/LICENSE.libwebp.txt"),
        binary = join(app, "Contents/MacOS/mikiko-computer-use");
      await copyFile(source, license);
      await writeFile(binary, "synthetic executable bytes");
      await chmod(binary, 0o555);
      await chmod(join(app, "Contents/Resources"), 0o555);
      await assert.rejects(assertMacBundleOwnerWrite(app), /owner-writable/);
      await normalizeMacBundleOwnerWrite(app);
      assert.equal(await mode(license), 0o644);
      assert.equal(await mode(binary), 0o755);
      assert.equal(await mode(join(app, "Contents/Resources")), 0o755);
      assert.equal(await mode(source), 0o444);
      assert.equal(await readFile(license, "utf8"), await readFile(source, "utf8"));
      assert.equal(await readFile(binary, "utf8"), "synthetic executable bytes");
      await assertMacBundleOwnerWrite(app);
    }),
);

test(
  "normalization never follows links into an external cache and rejects a symlink root",
  posix,
  async () =>
    fixture(async (root) => {
      const app = join(root, "Mikiko.app"),
        outside = join(root, "upstream-cache"),
        link = join(root, "Linked.app");
      await mkdir(app);
      await mkdir(outside);
      const source = join(outside, "LICENSE");
      await writeFile(source, "keep source unchanged");
      await chmod(source, 0o444);
      await symlink(outside, join(app, "external"));
      await symlink(app, link);
      await normalizeMacBundleOwnerWrite(app);
      await assertMacBundleOwnerWrite(app);
      assert.equal(await mode(source), 0o444);
      assert.equal(await readlink(join(app, "external")), outside);
      await assert.rejects(normalizeMacBundleOwnerWrite(link), /real.*app directory/i);
    }),
);

test("validation rejects a readonly resource without changing its mode", posix, async () =>
  fixture(async (root) => {
    const app = join(root, "Mikiko.app");
    await mkdir(app);
    const resource = join(app, "LICENSE.libwebp.txt");
    await writeFile(resource, "synthetic");
    await chmod(resource, 0o444);
    await assert.rejects(assertMacBundleOwnerWrite(app), /owner-writable.*LICENSE.libwebp.txt/);
    assert.equal(await mode(resource), 0o444);
  }),
);

test(
  "ShipIt quarantine removal succeeds after normalization on a real macOS synthetic file",
  { skip: process.platform !== "darwin" },
  async () =>
    fixture(async (root) => {
      const app = join(root, "Mikiko.app");
      await mkdir(app);
      const resource = join(app, "LICENSE.libwebp.txt");
      await writeFile(resource, "Synthetic quarantine test only\n");
      await exec("/usr/bin/xattr", [
        "-w",
        "com.apple.quarantine",
        "0083;00000000;MikikoPermissionRegression;",
        resource,
      ]);
      await chmod(resource, 0o444);
      await assert.rejects(exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", resource]));
      await normalizeMacBundleOwnerWrite(app);
      await exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", resource]);
      assert.ok(
        !(await exec("/usr/bin/xattr", [resource])).stdout.includes("com.apple.quarantine"),
      );
    }),
);

test(
  "desktop staging rejects readonly signed-cache resources without rewriting or copying them",
  posix,
  async () =>
    fixture(async (root) => {
      const { stageMikikoComputerUseResources } =
        await import("../../packages/desktop/scripts/mikiko-computer-use-assets.mjs");
      const { createHash } = await import("node:crypto");
      const source = join(root, ".cache/mikiko-computer-use/production/arm64/release");
      const app = join(source, "Mikiko Computer Use.app");
      await mkdir(join(app, "Contents/MacOS"), { recursive: true });
      await mkdir(join(app, "Contents/Resources"));
      const binary = join(app, "Contents/MacOS/mikiko-computer-use"),
        license = join(app, "Contents/Resources/LICENSE.libwebp.txt");
      await writeFile(binary, "synthetic executable");
      await writeFile(license, "synthetic license");
      await chmod(license, 0o444);
      await writeFile(
        join(source, "provenance.json"),
        JSON.stringify({
          production: true,
          bundleIdentifier: "dev.mikiko.computer-use",
          architecture: "arm64",
          minimumMacOS: "14.0",
          appVariant: "production",
          socketNamespace: "mikiko-production",
          executableSha256: createHash("sha256").update("synthetic executable").digest("hex"),
        }),
      );
      await assert.rejects(
        stageMikikoComputerUseResources({ repoRoot: root, arch: "arm64" }),
        /owner-writable.*LICENSE.libwebp.txt/,
      );
      assert.equal(await mode(license), 0o444);
      await assert.rejects(
        lstat(join(root, "packages/desktop/bundled-tools/darwin-arm64/mikiko-computer-use")),
        { code: "ENOENT" },
      );
    }),
);
