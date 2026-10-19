#!/usr/bin/env node
/**
 * Runtime 可执行文件快速预签名（specs/desktop/macos-signing.md）。
 *
 * 背景：electron-builder 移除 signIgnore 后会对 .app 全量深度扫描签名，在本包
 * Contents/Resources/glm 的 node_modules 树上实测超过 60 分钟（GitHub runner 超时）。
 * 本脚本在 afterPack 阶段只找 Mach-O 文件（file 输出含 "Mach-O"），并行 codesign，
 * 通常 <2 分钟完成；之后 electron-builder 通过 signIgnore 跳过这两个目录。
 *
 * 用法（由 electron-builder.config.js afterPack 链调用，不单独执行）：
 *   signRuntimeExecutables(context, { identity })
 * 未开启签名模式时是 no-op。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PARALLEL_LIMIT = 8;

export function signRuntimeExecutables(context, options = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const identity = options.identity;
  if (!identity) {
    console.log("[afterPack][sign-runtime] 未提供签名身份，跳过 runtime 预签名");
    return;
  }
  const appName = context.packager?.appInfo?.productFilename ?? "Mikiko";
  const appPath = join(context.appOutDir, `${appName}.app`, "Contents", "Resources");
  const targets = ["glm", "tools", "macos-window-bounds"];

  const startMs = Date.now();
  console.log(`[ci][timer] afterPack:signRuntimeExecutables start`);
  const binaries = [];
  for (const dir of targets) {
    const full = join(appPath, dir);
    try {
      statSync(full);
    } catch {
      continue;
    }
    collectMachO(full, binaries);
  }
  console.log(`[afterPack][sign-runtime] ${dirList(targets)} 下找到 ${binaries.length} 个 Mach-O`);
  if (binaries.length === 0) return;

  const entitlementsPath = join(import.meta.dirname, "..", "build", "entitlements.mac.inherit.plist");
  let signed = 0;
  let failed = 0;
  const queue = [...binaries];
  const workers = Array.from({ length: Math.min(PARALLEL_LIMIT, queue.length) }, () => {
    return new Promise((resolve) => {
      const next = () => {
        const file = queue.shift();
        if (!file) return resolve();
        try {
          execFileSync(
            "/usr/bin/codesign",
            [
              "--sign", identity,
              "--force",
              "--timestamp",
              "--options", "runtime",
              "--entitlements", entitlementsPath,
              file,
            ],
            { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
          );
          signed += 1;
        } catch (error) {
          // 已有同身份签名且校验通过的文件跳过（--force 会重签但某些只读挂载可失败）。
          try {
            execFileSync("/usr/bin/codesign", ["--verify", file], { stdio: "ignore", timeout: 5_000 });
            signed += 1;
          } catch {
            failed += 1;
            console.error(`[afterPack][sign-runtime] 签名失败: ${file}: ${error.message?.slice(0, 200)}`);
          }
        }
        next();
      };
      next();
    });
  });
  Promise.all(workers).then(() => {
    console.log(
      `[afterPack][sign-runtime] 完成：${signed} 签名 / ${failed} 失败 / ${binaries.length} 总计`,
    );
    console.log(`[ci][timer] afterPack:signRuntimeExecutables end duration_ms=${Date.now() - startMs}`);
    if (failed > 0) {
      throw new Error(`Runtime 预签名有 ${failed} 个文件失败，公证会被拒绝`);
    }
  });
}

function collectMachO(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMachO(path, out);
    } else if (entry.isFile() && isMachOFile(path)) {
      out.push(path);
    }
  }
}

function isMachOFile(path) {
  try {
    const out = execFileSync("/usr/bin/file", ["-b", path], { encoding: "utf8", timeout: 3_000 });
    return out.includes("Mach-O");
  } catch {
    return false;
  }
}

function dirList(dirs) {
  return dirs.join("/");
}
