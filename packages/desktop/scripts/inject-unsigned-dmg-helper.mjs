#!/usr/bin/env node
/* eslint-disable no-console */
// 未签名 DMG 安装说明注入器（specs/desktop/dmg-installer.md 的唯一写入路径）。
// electron-builder 26 的 DmgOptions 不支持向 DMG 根目录添加额外文件，这里在打包完成后
// 用 hdiutil 的 shadow 机制把「安装必读」说明文件写入只读 UDZO 镜像：
// attach -shadow 挂载 → 拷入文件 → detach → convert -shadow 合并回 UDZO。
// 说明文件是纯 txt：早期版本用 .command 可双击脚本，但从未签名 DMG 卷上执行会被
// Gatekeeper 与卷路径问题卡死；改为引导用户把应用拖入 Applications 后在终端手动执行 xattr。
// 注入会改变 DMG 字节内容，同目录的 .dmg.blockmap 随之失效；自动更新已被
// ZCODE_UPDATES_ENABLED 屏蔽，blockmap 无消费方，注入后直接删除并在有消费方恢复时重估。

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const helperSourcePath = resolve(desktopRoot, "build", "dmg-install-readme.txt");
const helperVolumeName = "安装必读.txt";
const distRoot = resolve(desktopRoot, process.env.ZCODE_DESKTOP_DIST_DIR || "dist");

function parseArgs(argv) {
  const options = { os: "mac", arch: "arm64" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--os") options.os = argv[(index += 1)];
    else if (arg === "--arch") options.arch = argv[(index += 1)];
    else throw new Error(`inject-unsigned-dmg-helper: 未知参数 ${arg}`);
  }
  return options;
}

const archHintsByArch = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};

function findLatestDmg(arch) {
  const archHints = archHintsByArch[arch] ?? [arch];
  const candidates = [];
  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dmg")) continue;
    const lowerName = entry.name.toLowerCase();
    if (!archHints.some((hint) => lowerName.includes(`-${hint}`))) continue;
    const fullPath = join(distRoot, entry.name);
    candidates.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
  }
  if (candidates.length === 0) {
    throw new Error(`inject-unsigned-dmg-helper: 未找到 ${arch} 的 DMG 产物（${distRoot}）`);
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].path;
}

function run(command, args) {
  execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
}

function detachVolume(mountPoint) {
  // 挂载点刚写入文件后立即 detach 偶发 Resource busy，这里带退避重试。
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      run("hdiutil", ["detach", mountPoint, "-force"]);
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      execFileSync("sleep", [String(attempt)]);
    }
  }
}

function main() {
  const { arch } = parseArgs(process.argv.slice(2));
  const dmgPath = findLatestDmg(arch);
  const workDir = mkdtempSync(join(tmpdir(), "mikiko-dmg-inject-"));
  const shadowPath = join(workDir, "changes.shadow");
  const mountPoint = join(workDir, "volume");
  const convertedPath = join(workDir, "converted.dmg");

  try {
    mkdirSync(mountPoint, { recursive: true });
    // 注意：shadow 挂载必须以可写模式进行（不能加 -readonly），否则文件拷贝不会进入 shadow 层。
    run("hdiutil", [
      "attach",
      dmgPath,
      "-shadow",
      shadowPath,
      "-nobrowse",
      "-mountpoint",
      mountPoint,
    ]);
    try {
      copyFileSync(helperSourcePath, join(mountPoint, helperVolumeName));
    } finally {
      detachVolume(mountPoint);
    }

    run("hdiutil", [
      "convert",
      dmgPath,
      "-shadow",
      shadowPath,
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-o",
      convertedPath,
    ]);

    // 合并 shadow 后的镜像必须先复验说明文件确实在卷内且内容一致，再覆盖原产物；
    // 避免把「看似成功实则缺文件」的 DMG 当作可分发产物。
    const verifyMountPoint = join(workDir, "verify");
    mkdirSync(verifyMountPoint, { recursive: true });
    run("hdiutil", [
      "attach",
      convertedPath,
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      verifyMountPoint,
    ]);
    try {
      const injectedHelper = join(verifyMountPoint, helperVolumeName);
      if (!existsSync(injectedHelper)) {
        throw new Error("inject-unsigned-dmg-helper: 注入后复验失败，卷内缺少安装说明文件");
      }
      const injectedSize = statSync(injectedHelper).size;
      const sourceSize = statSync(helperSourcePath).size;
      if (injectedSize !== sourceSize) {
        throw new Error(
          `inject-unsigned-dmg-helper: 注入后复验失败，说明文件大小不一致 (${injectedSize} != ${sourceSize})`,
        );
      }
    } finally {
      detachVolume(verifyMountPoint);
    }

    // tmp 目录与 dist 可能不在同一文件系统，rename 会 EX_DEV，统一走 copy 覆盖。
    copyFileSync(convertedPath, dmgPath);
    rmSync(convertedPath);
    const blockmapPath = `${dmgPath}.blockmap`;
    if (existsSync(blockmapPath)) {
      rmSync(blockmapPath);
      console.log(
        `[inject-unsigned-dmg-helper] 已删除失效 blockmap（自动更新已屏蔽，无消费方）: ${blockmapPath}`,
      );
    }
    console.log(`[inject-unsigned-dmg-helper] 已注入未签名 DMG 安装说明: ${dmgPath}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
