#!/usr/bin/env node
/**
 * 发布升级 feed（spec specs/update/update-service.md）。
 *
 * 读取本地 dist 目录（electron-builder 产物 + latest*.yml），把 yml 里的相对 url 重写为
 * agent-dl 绝对地址后经 /admin/channel 发布；安装包与 blockmap 经 /admin/files（超过阈值
 * 自动走 multipart 分片，规避 Workers 免费版 100MB 请求体上限）。
 *
 * 用法：
 *   node scripts/publish-update-feed.mjs --dist packages/desktop/dist --version 1.0.0 \
 *     --channel stable [--endpoint https://agent-update.mikiko.ai] [--download-origin https://agent-dl.mikiko.ai] \
 *     [--release-notes release-notes.md]
 *   环境变量：UPDATE_PUBLISH_TOKEN（必须）；--release-notes 为 markdown 文件，
 *   注入 latest*.yml 的 releaseNotesByLocale 作为客户端更新日志，并（配置
 *   MIKIKO_RELEASE_PUBLISH_TOKEN 时，与 Worker 侧 secret 同名）自动追加到 agent.mikiko.ai 官网更新日志。
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const distDir = readArg("dist") ?? "packages/desktop/dist";
const version = readArg("version");
const channel = readArg("channel") ?? "stable";
const endpoint = readArg("endpoint") ?? "https://agent-update.mikiko.ai";
const downloadOrigin = readArg("download-origin") ?? "https://agent-dl.mikiko.ai";
const releaseNotesPath = readArg("release-notes");
const token = process.env.UPDATE_PUBLISH_TOKEN;
const MULTIPART_THRESHOLD = 90 * 1024 * 1024;

if (!version || !token) {
  console.error("需要 --version 与环境变量 UPDATE_PUBLISH_TOKEN");
  process.exit(1);
}

async function publishBytes(path, body, contentType, multipartKey) {
  if (body.byteLength <= MULTIPART_THRESHOLD) {
    const response = await fetchWithRetry(
      `${endpoint}${path}`,
      {
        method: "PUT",
        headers: { "x-publish-token": token, "content-type": contentType },
        body,
      },
      path,
    );
    if (!response.ok) {
      throw new Error(`上传失败 ${path}: ${response.status} ${await response.text()}`);
    }
    return;
  }
  // 分片：init → parts → complete。
  const init = await fetchWithRetry(
    `${endpoint}/admin/multipart/init`,
    {
      method: "POST",
      headers: { "x-publish-token": token, "content-type": "application/json" },
      body: JSON.stringify({ key: multipartKey, contentType }),
    },
    "multipart init",
  );
  const initBody = await init.json();
  if (!init.ok) {
    throw new Error(`multipart init 失败: ${init.status} ${JSON.stringify(initBody)}`);
  }
  const partSize = 80 * 1024 * 1024;
  const parts = [];
  for (let offset = 0, number = 1; offset < body.byteLength; offset += partSize, number++) {
    const chunk = body.subarray(offset, Math.min(offset + partSize, body.byteLength));
    const partResponse = await fetchWithRetry(
      `${endpoint}/admin/multipart/${initBody.uploadId}/${number}?key=${encodeURIComponent(multipartKey)}`,
      {
        method: "PUT",
        headers: { "x-publish-token": token, "content-type": "application/octet-stream" },
        body: chunk,
      },
      `分片 ${number}`,
    );
    const partBody = await partResponse.json();
    if (!partResponse.ok) {
      throw new Error(`分片 ${number} 失败: ${partResponse.status} ${JSON.stringify(partBody)}`);
    }
    parts.push({ etag: partBody.etag, partNumber: number });
    console.log(`  part ${number}/${Math.ceil(body.byteLength / partSize)} 上传完成`);
  }
  const complete = await fetchWithRetry(
    `${endpoint}/admin/multipart/complete`,
    {
      method: "POST",
      headers: { "x-publish-token": token, "content-type": "application/json" },
      body: JSON.stringify({ uploadId: initBody.uploadId, key: multipartKey, parts }),
    },
    "multipart complete",
  );
  if (!complete.ok) {
    throw new Error(`multipart complete 失败: ${complete.status} ${await complete.text()}`);
  }
}

/**
 * 上传重试（2026-09-24）：100-190MB 安装包经 Workers multipart 上传时，单连接
 * 偶发 CF 边缘断流（CI 实测 500 part_failed "Network connection lost"、本地实测
 * EPIPE），一条分片失败就整体退出会让发布半途而废且只能人工补发。网络类失败
 * 与 5xx 按 2s/4s/8s 退避重试 3 次；4xx 是确定性错误（鉴权/参数），原样抛出。
 */
async function fetchWithRetry(url, init, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500) {
        return response;
      }
      lastError = new Error(`${label}: HTTP ${response.status}`);
      console.warn(`  ${lastError.message}，${attempt < attempts ? "退避重试" : "放弃"}`);
    } catch (error) {
      lastError = error;
      console.warn(
        `  ${label} 网络异常（${error.cause?.code ?? error.message}），${attempt < attempts ? "退避重试" : "放弃"}`,
      );
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function statFileOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function rewriteManifest(filePath, version, origin, releaseNotesYaml) {
  const raw = await readFile(filePath, "utf8");
  return (
    raw.replace(/^( *- )url: (?!https?:)(\S+)$/gm, `$1url: ${origin}/files/${version}/$2`) +
    releaseNotesYaml
  );
}

async function main() {
  const entries = await readdir(distDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  // archDirs 必须先于下方第一步资产收集定义（v1.0.7 CI 曾因定义晚于使用触发
  // TDZ ReferenceError，R2 feed 发布整体失败）：CI 分目录布局的安装包位于
  // installers-{target}-{arch}/ 子目录，此处统一解析供资产收集与清单归档两处使用。
  const archDirs = entries.filter(
    (entry) => entry.isDirectory() && /^installers-/.test(entry.name),
  );
  // 1. 安装包 + blockmap（同名文件按平台清单引用）。
  const assetPattern = /\.(dmg|zip|exe|AppImage|deb|rpm|pkg\.tar\.zst|blockmap)$/;
  // CI 布局下安装包分散在 installers-{target}-{arch}/ 子目录（文件名含架构不冲突）。
  const assets = [];
  for (const name of files.filter((name) => assetPattern.test(name))) {
    assets.push({ name, base: distDir });
  }
  for (const dir of archDirs) {
    const dirFiles = (await readdir(join(distDir, dir.name))).filter((name) =>
      assetPattern.test(name),
    );
    for (const name of dirFiles) {
      assets.push({ name, base: join(distDir, dir.name) });
    }
  }
  for (const { name, base } of assets) {
    const filePath = join(base, name);
    const info = await stat(filePath);
    const contentType = name.endsWith(".exe")
      ? "application/x-msdownload"
      : name.endsWith(".dmg")
        ? "application/x-apple-diskimage"
        : "application/octet-stream";
    const key = `files/${version}/${name}`;
    console.log(`上传 ${name} (${(info.size / 1024 / 1024).toFixed(1)}MB) → ${key}`);
    const body = new Uint8Array(await readFile(filePath));
    await publishBytes(`/admin/files/${key}`, body, contentType, key);
  }

  // 2. 通道清单：重写 yml 相对 url 为下载域绝对地址，并注入更新日志（releaseNotesByLocale，
  //    与官方 manifest 同字段；客户端 autoUpdater.toPostUpdateReleaseNotesPayload 读取展示）。
  const releaseNotesMarkdown = releaseNotesPath
    ? (await readFile(releaseNotesPath, "utf8")).replace(/\r\n/g, "\n").trim()
    : "";
  const releaseNotesYaml = buildReleaseNotesYaml(releaseNotesMarkdown, version);

  /**
   * per-arch 清单归档（2026-09-29 应用内更新适配 arm64）：
   * CI 自 v1.0.7 起 download-artifact 不再 merge，dist 下按 `installers-{target}-{arch}/`
   * 分目录存放各架构产物；同名 latest*.yml 不再互相覆盖。归档规则：
   *   mac-arm64 → latest-mac-arm64.yml；mac-x64 → latest-mac-x64.yml + 兼容键 latest-mac.yml
   *   win-x64 → latest.yml（历史键）；win-arm64 → latest-arm64.yml；linux-x64 → latest-linux.yml
   * 兼容键（x64 双写）保证只升级过 update-service、还没发新版时的回退路径完整。
   * 本地扁平 dist（无子目录）时按旧逻辑发布原文件名。
   */
  if (archDirs.length > 0) {
    const keyMap = [
      { dir: "installers-mac-arm64", file: "latest-mac.yml", keys: ["latest-mac-arm64.yml"] },
      {
        dir: "installers-mac-x64",
        file: "latest-mac.yml",
        keys: ["latest-mac-x64.yml", "latest-mac.yml"],
      },
      { dir: "installers-win-x64", file: "latest.yml", keys: ["latest.yml"] },
      { dir: "installers-win-arm64", file: "latest.yml", keys: ["latest-arm64.yml"] },
      {
        dir: "installers-linux-x64",
        file: "latest-linux.yml",
        keys: ["latest-linux.yml"],
      },
    ];
    for (const { dir, file, keys } of keyMap) {
      const filePath = join(distDir, dir, file);
      if (!(await statFileOrNull(filePath))) continue;
      const rewritten = await rewriteManifest(filePath, version, downloadOrigin, releaseNotesYaml);
      for (const key of keys) {
        const channelKey = `channels/${channel}/${key}`;
        console.log(
          `发布清单 ${dir}/${file} → ${channelKey}${releaseNotesYaml ? "（含更新日志）" : ""}`,
        );
        await publishBytes(
          `/admin/channel/${channel}/${key}`,
          new TextEncoder().encode(rewritten),
          "application/x-yaml",
          channelKey,
        );
      }
    }
  } else {
    const manifests = files.filter((name) => /^latest(-mac|-linux)?\.yml$/.test(name));
    for (const name of manifests) {
      const raw = await readFile(join(distDir, name), "utf8");
      const rewritten =
        raw.replace(
          /^( *- )url: (?!https?:)(\S+)$/gm,
          `$1url: ${downloadOrigin}/files/${version}/$2`,
        ) + releaseNotesYaml;
      const key = `channels/${channel}/${name}`;
      console.log(`发布清单 ${name} → ${key}${releaseNotesYaml ? "（含更新日志）" : ""}`);
      await publishBytes(
        `/admin/channel/${channel}/${name}`,
        new TextEncoder().encode(rewritten),
        "application/x-yaml",
        key,
      );
    }
  }
  // 3. 官网更新日志（2026-09-28 全自动发版）：同一份 release notes 推到
  //    agent.mikiko.ai（/api/v1/admin/release-notes，X-Publish-Token 鉴权）。
  //    未配置令牌时仅提示跳过——官网日志缺失不阻塞升级发布。
  if (!releaseNotesMarkdown) {
    console.log("未提供 --release-notes，跳过官网更新日志。");
  } else {
    const websiteToken = process.env.MIKIKO_RELEASE_PUBLISH_TOKEN;
    const websiteEndpoint = readArg("website-endpoint") ?? "https://agent.mikiko.ai";
    if (!websiteToken) {
      console.warn(
        "MIKIKO_RELEASE_PUBLISH_TOKEN 未配置，跳过官网更新日志（版本与下载链接仍会经 manifest 聚合自动更新）。",
      );
    } else {
      const response = await fetchWithRetry(
        `${websiteEndpoint}/api/v1/admin/release-notes`,
        {
          method: "PUT",
          headers: { "x-publish-token": websiteToken, "content-type": "application/json" },
          body: JSON.stringify({ version, markdown: releaseNotesMarkdown }),
        },
        "官网更新日志",
      );
      if (!response.ok) {
        console.warn(`官网更新日志发布失败: ${response.status} ${await response.text()}`);
      } else {
        console.log(`官网更新日志已发布（v${version}）。`);
      }
    }
  }
  console.log("完成。");
}

/**
 * 更新日志（2026-09-24 用户需求）：electron-builder 产物 yml 不带 release notes，
 * 注入 releaseNotesByLocale（zh-CN/en-US 同内容，客户端 zh 优先回退 en）后，
 * 「发现更新」弹窗与安装后说明才能展示自建版本日志——1.0.0 之前日志实际来自
 * 误连的官方 manifest。标题用显式文案（Release 正文只有 ## 分节，无 H1）。
 */
function buildReleaseNotesYaml(markdown, version) {
  if (!markdown) {
    return "";
  }
  const title = `Mikiko ${version} 更新日志`;
  const indented = markdown
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `      ${line}` : ""))
    .join("\n");
  const localeBlock = `    title: ${JSON.stringify(title)}\n    markdown: |\n${indented}\n`;
  return `releaseNotesByLocale:\n  zh-CN:\n${localeBlock}  en-US:\n${localeBlock}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
