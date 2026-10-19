#!/usr/bin/env node
/**
 * Runtime 可执行文件快速预签名（specs/desktop/macos-signing.md）。
 *
 * 背景：electron-builder 移除 signIgnore 后会对 .app 全量深度扫描签名，在本包
 * Contents/Resources/glm 的 node_modules 树上实测超过 60 分钟（GitHub runner 超时）。
 * 本脚本在 afterPack 阶段只找 Mach-O 文件（file 输出含 "Mach-O"），并行 codesign，
 * 通常 <2 分钟完成；之后 electron-builder 通过 signIgnore 跳过这两个目录。
 *
 * 嵌套二进制不使用 --timestamp（Apple 只要求最外层签名的 secure timestamp；
 * 嵌套时间戳请求在部分 runner 上会卡 Apple TSA 服务器导致超时——2026-10-19
 * macos-window-bounds 二进制连续两次 120s 超时的实测结论）。
 *
 * 用法（由 electron-builder.config.js afterPack 链调用，不单独执行）：
 *   await signRuntimeExecutables(context, { identity })
 * 未开启签名模式时是 no-op。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PARALLEL_LIMIT = 8;

export async function signRuntimeExecutables(context, options = {}) {
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
  console.log("[ci][timer] afterPack:signRuntimeExecutables start");
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
  console.log(
    `[afterPack][sign-runtime] ${targets.join("/")} 下找到 ${binaries.length} 个 Mach-O`,
  );
  if (binaries.length === 0) return;

  const entitlementsPath = join(import.meta.dirname, "..", "build", "entitlements.mac.inherit.plist");
  let signed = 0;
  let failed = 0;
  const queue = [...binaries];
  const workers = Array.from(
    { length: Math.min(PARALLEL_LIMIT, queue.length) },
    () =>
      new Promise((resolve) => {
        const next = () => {
          const file = queue.shift();
          if (!file) return resolve();
          // linker-signed 通用二进制（ad hoc）先剥离旧签名——codesign --force
          // 在部分 runner 上对带 adhoc 签名的 fat binary 挂起（2026-10-19 连续
          // 三次 30s/120s ETIMEDOUT 实测；剥离后重签秒过）。
          try {
            execFileSync("/usr/bin/codesign", ["--remove-signature", file], {
              stdio: "ignore",
              timeout: 10_000,
            });
          } catch {
            // 没有（或剥不掉）旧签名时直接尝试签名。
          }
          try {
            execFileSync(
              "/usr/bin/codesign",
              [
                "--sign", identity,
                "--force",
                "--options", "runtime",
                "--entitlements", entitlementsPath,
                file,
              ],
              { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
            );
            signed += 1;
          } catch {
            // 完整签名失败（如 entitlements 对 linker-signed 通用二进制挂起）：
            // 降级为不带 entitlements 的基础 Developer ID 签名，公证仍接受。
            try {
              execFileSync(
                "/usr/bin/codesign",
                ["--sign", identity, "--force", file],
                { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
              );
              signed += 1;
              console.warn(`[afterPack][sign-runtime] 降级签名（无 entitlements）: ${file}`);
            } catch (error) {
              try {
                execFileSync("/usr/bin/codesign", ["--verify", file], {
                  stdio: "ignore",
                  timeout: 5_000,
                });
                signed += 1;
              } catch {
                failed += 1;
                console.error(
                  `[afterPack][sign-runtime] 签名失败: ${file}: ${error.message?.slice(0, 200)}`,
                );
              }
            }
          }
          next();
        };
        next();
      }),
  );
  await Promise.all(workers);
  console.log(
    `[afterPack][sign-runtime] 完成：${signed} 签名 / ${failed} 失败 / ${binaries.length} 总计`,
  );
  console.log(
    `[ci][timer] afterPack:signRuntimeExecutables end duration_ms=${Date.now() - startMs}`,
  );
  if (failed > 0) {
    throw new Error(`Runtime 预签名有 ${failed} 个文件失败，公证会被拒绝`);
  }
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
    const out = execFileSync("/usr/bin/file", ["-b", path], {
      encoding: "utf8",
      timeout: 3_000,
    });
    return out.includes("Mach-O");
  } catch {
    return false;
  }
}
