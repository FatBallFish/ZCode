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
 *     --channel stable [--endpoint https://agent-update.mikiko.ai] [--download-origin https://agent-dl.mikiko.ai]
 *   环境变量：UPDATE_PUBLISH_TOKEN（必须）
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

async function main() {
  const files = await readdir(distDir);
  // 1. 安装包 + blockmap（同名文件按平台清单引用）。
  const assetPattern = /\.(dmg|zip|exe|AppImage|deb|rpm|pkg\.tar\.zst|blockmap)$/;
  const assets = files.filter((name) => assetPattern.test(name));
  for (const name of assets) {
    const filePath = join(distDir, name);
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

  // 2. 通道清单：重写 yml 相对 url 为下载域绝对地址。
  const manifests = files.filter((name) => /^latest(-mac|-linux)?\.yml$/.test(name));
  for (const name of manifests) {
    const raw = await readFile(join(distDir, name), "utf8");
    const rewritten = raw.replace(
      /^( *- )url: (?!https?:)(\S+)$/gm,
      `$1url: ${downloadOrigin}/files/${version}/$2`,
    );
    const key = `channels/${channel}/${name}`;
    console.log(`发布清单 ${name} → ${key}`);
    await publishBytes(
      `/admin/channel/${channel}/${name}`,
      new TextEncoder().encode(rewritten),
      "application/x-yaml",
      key,
    );
  }
  console.log("完成。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
