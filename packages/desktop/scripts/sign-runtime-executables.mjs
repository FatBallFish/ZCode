#!/usr/bin/env node
/** glm/tools 的 Mach-O 在主 App 封印和 DMG/ZIP 封装前签名；见 specs/desktop/macos-signing.md。 */
import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MACH_O_MAGIC = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

async function collectMachO(directory, binaries, optional = false) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (optional && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMachO(path, binaries);
    } else if (entry.isFile()) {
      // .node 不一定有执行位；只读文件头，不对每个 JS/JSON 启动 file 子进程，也不跟随符号链接。
      const file = await open(path, "r");
      try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await file.read(header, 0, 4, 0);
        if (bytesRead === 4 && MACH_O_MAGIC.has(header.toString("hex"))) binaries.push(path);
      } finally {
        await file.close();
      }
    }
  }
}

export async function signRuntimeExecutables(context, options = {}) {
  if (context.electronPlatformName !== "darwin" || !options.identity) return;
  const appName = context.packager?.appInfo?.productFilename ?? "Mikiko";
  const resources = join(context.appOutDir, `${appName}.app`, "Contents", "Resources");
  const binaries = [];
  for (const target of ["glm", "tools"]) {
    await collectMachO(join(resources, target), binaries, true);
  }

  const run = options.execFileImpl ?? execFileAsync;
  const keychain = options.keychain ?? process.env.CSC_KEYCHAIN;
  const entitlements = join(import.meta.dirname, "..", "build", "entitlements.mac.inherit.plist");
  let nextIndex = 0;
  let failure;
  console.log(`[afterPack][sign-runtime] Mach-O count=${binaries.length}`);
  // 原实现的 Promise 包裹 execFileSync 仍然串行；真实异步子进程才能保持有界并发。
  // 钥匙链错误不能通过去掉 timestamp/runtime 或接受旧 ad-hoc 签名来降级掩盖。
  const workers = Array.from({ length: Math.min(4, binaries.length) }, async () => {
    while (!failure && nextIndex < binaries.length) {
      const file = binaries[nextIndex++];
      const startedAt = Date.now();
      console.log(`[afterPack][sign-runtime] start file=${file}`);
      try {
        await run(
          "/usr/bin/codesign",
          [
            "--sign",
            options.identity,
            "--force",
            "--timestamp",
            "--options",
            "runtime",
            "--entitlements",
            entitlements,
            ...(keychain ? ["--keychain", keychain] : []),
            file,
          ],
          { timeout: 120_000, killSignal: "SIGKILL" },
        );
        console.log(
          `[afterPack][sign-runtime] signed file=${file} duration_ms=${Date.now() - startedAt}`,
        );
      } catch (error) {
        failure ??= new Error(`Runtime signing failed: ${file}: ${error.stderr || error.message}`, {
          cause: error,
        });
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}
