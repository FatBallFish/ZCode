/**
 * Mikiko 自建升级服务（Cloudflare Worker，spec specs/update/update-service.md）。
 *
 * 两个自定义域名（按 Host 分流）：
 *  - agent-update.mikiko.ai：更新清单与强更配置 API（替代原智谱官方端点）。
 *  - agent-dl.mikiko.ai：R2 安装包下载代理（Range/缓存/不可变语义）。
 *
 * R2 布局（由 Release 流水线写入）：
 *  - files/{version}/{asset}                     安装包与 blockmap
 *  - channels/{channel}/{platform}.yml           electron-updater UpdateInfo 清单
 *    （platform ∈ darwin-aarch64 | darwin-x86_64 | windows-x86_64 | linux-x86_64；
 *     channel ∈ stable | preview，URL 已重写为 agent-dl 绝对地址）
 *
 * KV 布局：
 *  - key "client-configs"：{ forceUpdate: { enabled, minimumVersion }, rollout: {...} }
 */

const SERVICE_VERSION = "1.0.0";

const PLATFORM_TO_MANIFEST: Record<string, string> = {
  "darwin-aarch64": "latest-mac.yml",
  "darwin-x86_64": "latest-mac.yml",
  "windows-x86_64": "latest.yml",
  "linux-x86_64": "latest-linux.yml",
  // 兼容 electron-updater 旧式的 platform 取值（含 .exe 后缀等）交由调用方规范化。
};

const DEFAULT_CLIENT_CONFIGS = {
  forceUpdate: { enabled: false, minimumVersion: "0.0.0" },
  rollout: { percent: 100 },
};

interface Env {
  RELEASES: R2Bucket;
  UPDATE_CONFIG: KVNamespace;
  /** 发布密钥（wrangler secret put PUBLISH_TOKEN）：CI 经 /admin/* 写入清单与配置。 */
  PUBLISH_TOKEN?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** GET /api/v1/releases/electron/manifest?platform=&channel= */
async function handleManifest(env: Env, url: URL): Promise<Response> {
  const platform = url.searchParams.get("platform")?.trim() ?? "";
  const channel = url.searchParams.get("channel")?.trim() === "3" ? "preview" : "stable";
  const manifestFile = PLATFORM_TO_MANIFEST[platform];
  if (!manifestFile) {
    return jsonResponse(
      { error: "unsupported_platform", platform, supported: Object.keys(PLATFORM_TO_MANIFEST) },
      400,
    );
  }
  const key = `channels/${channel}/${manifestFile}`;
  const object = await env.RELEASES.get(key);
  if (object == null) {
    // 无可用版本（如首个版本发布前）：对 electron-updater 表现为“暂无更新”。
    return jsonResponse({ error: "no_release", channel, platform }, 404);
  }
  const body = await object.text();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-yaml; charset=utf-8",
      // 清单跟随发布节奏，短缓存即可；channel/platform 差异经 query 天然分键。
      "cache-control": "public, max-age=60",
    },
  });
}

/** GET /api/v1/client/configs：强更与灰度配置（KV 单键，发布侧可随时改写）。 */
async function handleClientConfigs(env: Env): Promise<Response> {
  let configs: unknown = DEFAULT_CLIENT_CONFIGS;
  try {
    const stored = await env.UPDATE_CONFIG.get("client-configs", "json");
    if (stored != null) {
      configs = stored;
    }
  } catch {
    // KV 异常回退默认（不强更、全量放开），保证客户端启动不被配置面阻塞。
  }
  return jsonResponse(configs);
}

/** agent-dl 下载代理：支持单 Range（electron-updater 关闭了多 Range）。 */
async function handleDownload(env: Env, url: URL, request: Request): Promise<Response> {
  const key = url.pathname.replace(/^\/+/, "");
  if (!key || key.includes("..")) {
    return jsonResponse({ error: "bad_key" }, 400);
  }
  const rangeHeader = request.headers.get("range");
  let range: { offset: number; length?: number } | undefined;
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const offset = Number.parseInt(match[1]!, 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : undefined;
      if (Number.isFinite(offset)) {
        range =
          end != null && Number.isFinite(end) ? { offset, length: end - offset + 1 } : { offset };
      }
    }
  }
  const object = await env.RELEASES.get(key, range ? { range } : undefined);
  if (object == null) {
    return jsonResponse({ error: "not_found", key }, 404);
  }
  const headers = new Headers({
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "accept-ranges": "bytes",
    // 安装包内容按版本寻址，不可变。
    "cache-control": "public, max-age=31536000, immutable",
    etag: object.httpEtag,
  });
  if (range && object.range) {
    // 206 响应中 object.size 为分片大小；总长经 R2 元数据补齐不可得时退回完整对象。
    const total = object.range.total ?? object.size;
    const end = object.range.offset + object.size - 1;
    headers.set("content-range", `bytes ${object.range.offset}-${end}/${total}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;
    try {
      if (host.startsWith("agent-dl.")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return jsonResponse({ error: "method_not_allowed" }, 405);
        }
        return handleDownload(env, url, request);
      }
      if (url.pathname === "/healthz") {
        return jsonResponse({ ok: true, version: SERVICE_VERSION });
      }
      if (url.pathname === "/api/v1/releases/electron/manifest") {
        if (request.method !== "GET") {
          return jsonResponse({ error: "method_not_allowed" }, 405);
        }
        return handleManifest(env, url);
      }
      if (url.pathname === "/api/v1/client/configs") {
        if (request.method !== "GET") {
          return jsonResponse({ error: "method_not_allowed" }, 405);
        }
        return handleClientConfigs(env);
      }
      if (url.pathname.startsWith("/admin/")) {
        return handleAdmin(env, url, request);
      }
      return jsonResponse({ error: "not_found", path: url.pathname }, 404);
    } catch (error) {
      return jsonResponse({ error: "internal", message: String(error) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * 发布端点（spec update-service）：CI 专用，X-Publish-Token 与 secret 比对。
 *  - PUT /admin/files/{key...}                  原始请求体写入 R2（Content-Type 透传）
 *  - PUT /admin/configs                         JSON 请求体写入 KV client-configs
 *  - PUT /admin/channel/{channel}/{platform}.yml 快捷发布通道清单（同 files）
 * 说明：wrangler CLI OAuth 的 r2/kv 写入不落真实存储（2026-09-24 实测），一切写入经本端点。
 */
async function handleAdmin(env: Env, url: URL, request: Request): Promise<Response> {
  if (!env.PUBLISH_TOKEN || request.headers.get("x-publish-token") !== env.PUBLISH_TOKEN) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // —— 分片上传（大安装包 >100MB，Workers 免费单请求体上限）——
  // POST /admin/multipart/init {"key","contentType"} → {uploadId}
  // PUT  /admin/multipart/{uploadId}/{partNumber}?key=...   body=分片 → {etag}
  // POST /admin/multipart/complete {"uploadId","key","parts":[{"etag","partNumber"}]}
  if (url.pathname === "/admin/multipart/init" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      key?: string;
      contentType?: string;
    } | null;
    if (!body?.key || body.key.includes("..")) {
      return jsonResponse({ error: "bad_key" }, 400);
    }
    const mp = env.RELEASES.createMultipartUpload(body.key, {
      httpMetadata: {
        contentType: body.contentType ?? "application/octet-stream",
      },
    });
    return jsonResponse({ ok: true, uploadId: (await mp).uploadId, key: body.key });
  }
  const mpMatch = /^\/admin\/multipart\/([^/]+)\/(\d+)$/.exec(url.pathname);
  if (mpMatch && request.method === "PUT") {
    const key = url.searchParams.get("key") ?? "";
    if (!key) {
      return jsonResponse({ error: "bad_key" }, 400);
    }
    const mp = env.RELEASES.resumeMultipartUpload(key, mpMatch[1]!);
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) {
      return jsonResponse({ error: "empty_body" }, 400);
    }
    try {
      const partNumber = Number(mpMatch[2]);
      const part = await mp.uploadPart(partNumber, body);
      return jsonResponse({ ok: true, etag: part.etag, partNumber });
    } catch (error) {
      return jsonResponse({ error: "part_failed", message: String(error) }, 500);
    }
  }
  if (url.pathname === "/admin/multipart/complete" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      uploadId?: string;
      key?: string;
      parts?: Array<{ etag?: string; partNumber?: number }>;
    } | null;
    if (!body?.uploadId || !body.key || !Array.isArray(body.parts)) {
      return jsonResponse({ error: "bad_request" }, 400);
    }
    const mp = env.RELEASES.resumeMultipartUpload(body.key, body.uploadId);
    await mp.complete(
      body.parts
        .filter((part) => typeof part.etag === "string" && typeof part.partNumber === "number")
        .map((part) => ({ etag: part.etag!, partNumber: part.partNumber! })),
    );
    return jsonResponse({ ok: true, key: body.key });
  }

  if (request.method !== "PUT") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  if (url.pathname === "/admin/configs") {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return jsonResponse({ error: "bad_json" }, 400);
    }
    await env.UPDATE_CONFIG.put("client-configs", JSON.stringify(value));
    return jsonResponse({ ok: true, kind: "configs" });
  }
  const key = url.pathname.replace(/^\/admin\/(?:files|channel\/[^/]+)\//, "");
  if (!key || key.includes("..")) {
    return jsonResponse({ error: "bad_key" }, 400);
  }
  const storageKey = url.pathname.startsWith("/admin/channel/")
    ? `channels/${url.pathname.split("/")[3]}/${key}`
    : key;
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return jsonResponse({ error: "empty_body" }, 400);
  }
  await env.RELEASES.put(storageKey, body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? "application/octet-stream",
    },
  });
  return jsonResponse({ ok: true, key: storageKey, bytes: body.byteLength });
}
