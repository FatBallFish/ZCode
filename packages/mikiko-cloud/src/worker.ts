/**
 * Mikiko 自建云端（Cloudflare Worker，spec specs/mikiko-cloud/agent-endpoint-plan.md）。
 *
 * agent.mikiko.ai 单域名：
 *  - /                                静态主页（public/index.html，介绍与下载入口）
 *  - /admin                           预置配置管理页（public/admin.html，账密鉴权）
 *  - GET /api/v1/builtin-provider-config  模型预置规则 Release（客户端 revision 热更）
 *  - GET /api/v1/client/configs           自建功能配置（dynamicWorkflow 灰度、分享限流）
 *  - POST /api/v1/admin/login 等           管理端点（session cookie 鉴权）
 *
 * KV 布局：
 *  - MIKIKO_BUILTIN_CONFIG：
 *      current            { schemaVersion, revision, updatedAt, config }
 *      revisions/r{N}     历史留档（与 current 同构）
 *  - MIKIKO_CLIENT_CONFIG：
 *      client-configs     { dynamicWorkflow: { mode }, share: { publishPerMinutePerIp } }
 *
 * Secrets（wrangler secret put，不入仓库）：
 *  - MIKIKO_ADMIN_USERNAME / MIKIKO_ADMIN_PASSWORD / MIKIKO_ADMIN_SESSION_SECRET
 */

import { handleShareRequest } from "./shares.js";
import { handleReleasesRequest } from "./releases.js";

const SERVICE_VERSION = "1.0.0";

const BUILTIN_CURRENT_KEY = "current";
const BUILTIN_REVISION_PREFIX = "revisions/r";
const CLIENT_CONFIGS_KEY = "client-configs";

const SESSION_COOKIE_NAME = "mikiko_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_FAILURE_DELAY_MS = 500;

/** 自建端点返回的 Release 上限（KV 单值 25MB，留余量给元数据）。 */
const BUILTIN_CONFIG_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 功能配置默认值（KV 异常 fail-open）：
 * dynamicWorkflow 取值域与客户端 shared 的 DYNAMIC_WORKFLOW_MODES 对齐（disabled/onDemand/alwaysOn），
 * 默认 alwaysOn——「工作流」标签是既有功能入口，自建配置面故障不得将其关闭；
 * 分享发布限流默认 3 次/分钟/IP（spec §4.3，阈值经此接口下发、服务端强制执行）。
 */
const DEFAULT_CLIENT_CONFIGS = {
  dynamicWorkflow: { mode: "alwaysOn" },
  share: { publishPerMinutePerIp: 3 },
} as const;

const DYNAMIC_WORKFLOW_MODES = new Set(["disabled", "onDemand", "alwaysOn"]);
const SHARE_RATE_LIMIT_MIN = 1;
const SHARE_RATE_LIMIT_MAX = 60;

interface BuiltinConfigRecord {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  config: {
    providerConfigRules: unknown;
    modelConfigRules: unknown;
  };
}

interface ClientConfigs {
  dynamicWorkflow: { mode: string };
  share: { publishPerMinutePerIp: number };
}

interface Env {
  MIKIKO_BUILTIN_CONFIG: KVNamespace;
  MIKIKO_CLIENT_CONFIG: KVNamespace;
  MIKIKO_SHARE: KVNamespace;
  SHARE_ARTIFACTS: R2Bucket;
  ASSETS?: Fetcher;
  MIKIKO_ADMIN_USERNAME?: string;
  MIKIKO_ADMIN_PASSWORD?: string;
  MIKIKO_ADMIN_SESSION_SECRET?: string;
  /** 发版流水线写官网更新日志的令牌（wrangler secret put）。 */
  MIKIKO_RELEASE_PUBLISH_TOKEN?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/healthz") {
        return jsonResponse({ ok: true, version: SERVICE_VERSION });
      }
      if (url.pathname.startsWith("/api/v1/shares/")) {
        return handleShareRequest({ request, env, url, origin: url.origin });
      }
      // releases 公开读 + release-notes 发布写（独立发布令牌鉴权，必须先于 admin session 分支）。
      if (
        url.pathname.startsWith("/api/v1/releases/") ||
        url.pathname === "/api/v1/admin/release-notes"
      ) {
        return handleReleasesRequest(request, env, url.pathname);
      }
      // 分享落地页 /cn/share/{code} 与 /share/{code}：静态资产不支持路径参数，
      // 由 Worker 统一改写到 share.html，页面自行解析 code 并调 preview API。
      // binding fetch 仍会应用 html_handling（/share.html 会 307 到 /share），
      // 需跟随一次重定向拿到最终页面（2026-09-28 落地页 404 报障：此前还因
      // wrangler 未声明 assets binding 导致 env.ASSETS 缺失整体 404）。
      if (/^\/(cn\/)?share\/[^/]+\/?$/u.test(url.pathname)) {
        if (!env.ASSETS) return new Response("Not Found", { status: 404 });
        const page = await env.ASSETS.fetch(new URL("/share.html", url.origin));
        if (page.status >= 300 && page.status < 400) {
          const location = page.headers.get("location");
          if (location) return env.ASSETS.fetch(new URL(location, url.origin));
        }
        return page;
      }
      if (url.pathname === "/api/v1/builtin-provider-config") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleBuiltinProviderConfig(env);
      }
      if (url.pathname === "/api/v1/client/configs") {
        if (request.method !== "GET") return methodNotAllowed();
        return handleClientConfigs(env);
      }
      if (url.pathname === "/api/v1/admin/login") {
        if (request.method !== "POST") return methodNotAllowed();
        return handleAdminLogin(request, env);
      }
      if (url.pathname.startsWith("/api/v1/admin/")) {
        if (!(await isAdminAuthorized(request, env))) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        return handleAdminApi(request, env, url.pathname);
      }
      // 其余路径交给静态资产（wrangler assets binding）；资产未命中时明确 404。
      return new Response("Not Found", { status: 404 });
    } catch {
      // 不把异常细节透出给公网调用方；客户端按状态码退避。信封带 msg 字段，
      // 与分享客户端 conversationShareErrorEnvelopeSchema 的 {code, msg} 纪律一致。
      return jsonResponse({ code: 500, msg: "internal" }, 500);
    }
  },
} satisfies { fetch: (request: Request, env: Env) => Promise<Response> };

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405);
}

/** GET /api/v1/builtin-provider-config：客户端按 revision 差量热更；短边缘缓存降低 KV 读频。 */
async function handleBuiltinProviderConfig(env: Env): Promise<Response> {
  const record = await readCurrentBuiltin(env);
  if (record === null) {
    // 尚未种子化：明确 404 提示（部署文档的初始化步骤未执行），客户端保留本地缓存继续运行。
    return jsonResponse({ error: "not_initialized" }, 404);
  }
  return jsonResponse(
    {
      schemaVersion: record.schemaVersion,
      revision: record.revision,
      config: record.config,
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

/** GET /api/v1/client/configs：功能配置 fail-open，KV 异常时返回默认。 */
async function handleClientConfigs(env: Env): Promise<Response> {
  let configs: unknown = DEFAULT_CLIENT_CONFIGS;
  try {
    const stored = await env.MIKIKO_CLIENT_CONFIG.get(CLIENT_CONFIGS_KEY, "json");
    if (stored != null) configs = stored;
  } catch {
    // KV 异常回退默认（dynamicWorkflow enabled + 默认限流），配置面不得阻塞客户端功能入口。
  }
  return jsonResponse({ code: 0, data: { configs } });
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  if (
    !env.MIKIKO_ADMIN_USERNAME ||
    !env.MIKIKO_ADMIN_PASSWORD ||
    !env.MIKIKO_ADMIN_SESSION_SECRET
  ) {
    // secrets 未配置：管理面整体不可用，公开端点不受影响。
    return jsonResponse({ error: "admin_not_configured" }, 503);
  }
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { username?: unknown; password?: unknown };
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const ok =
    (await timingSafeEqualString(username, env.MIKIKO_ADMIN_USERNAME)) &&
    (await timingSafeEqualString(password, env.MIKIKO_ADMIN_PASSWORD));
  if (!ok) {
    // 固定延迟抬高爆破成本；不区分「用户名错误/密码错误」。
    await delayMs(LOGIN_FAILURE_DELAY_MS);
    return jsonResponse({ error: "invalid_credential" }, 401);
  }
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const token = await signSessionToken(expiresAt, env.MIKIKO_ADMIN_SESSION_SECRET);
  return jsonResponse({ ok: true, expiresAt }, 200, {
    "set-cookie": [
      `${SESSION_COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${SESSION_TTL_SECONDS}`,
    ].join("; "),
  });
}

async function handleAdminApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/api/v1/admin/builtin-config") {
    if (request.method === "GET") return handleAdminGetBuiltin(env);
    if (request.method === "PUT") return handleAdminPutBuiltin(request, env);
    return methodNotAllowed();
  }
  if (pathname === "/api/v1/admin/builtin-config/history") {
    if (request.method !== "GET") return methodNotAllowed();
    return handleAdminBuiltinHistory(env);
  }
  if (pathname === "/api/v1/admin/client-configs") {
    if (request.method === "GET") return handleAdminGetClientConfigs(env);
    if (request.method === "PUT") return handleAdminPutClientConfigs(request, env);
    return methodNotAllowed();
  }
  return jsonResponse({ error: "not_found" }, 404);
}

async function handleAdminGetBuiltin(env: Env): Promise<Response> {
  const record = await readCurrentBuiltin(env);
  if (record === null) {
    return jsonResponse({ initialized: false }, 200);
  }
  return jsonResponse({
    initialized: true,
    revision: record.revision,
    updatedAt: record.updatedAt,
    config: record.config,
  });
}

/**
 * PUT /api/v1/admin/builtin-config
 *  - { config: { providerConfigRules, modelConfigRules } }：发布新配置，revision 服务端自增。
 *  - { restoreRevision: N }：从历史留档恢复为新的当前版本（revision 仍自增，保持单调）。
 */
async function handleAdminPutBuiltin(request: Request, env: Env): Promise<Response> {
  let body: { config?: unknown; restoreRevision?: unknown };
  try {
    body = (await request.json()) as { config?: unknown; restoreRevision?: unknown };
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }

  const current = await readCurrentBuiltin(env);
  const nextRevision = (current?.revision ?? 0) + 1;

  let config: { providerConfigRules: unknown; modelConfigRules: unknown };
  if (body.restoreRevision !== undefined) {
    const revision = body.restoreRevision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
      return jsonResponse({ error: "bad_restore_revision" }, 400);
    }
    const archived = await env.MIKIKO_BUILTIN_CONFIG.get(
      `${BUILTIN_REVISION_PREFIX}${revision}`,
      "json",
    );
    if (archived == null) {
      return jsonResponse({ error: "revision_not_found", revision }, 404);
    }
    config = (archived as BuiltinConfigRecord).config;
  } else {
    const validation = validateBuiltinConfig(body.config);
    if (!validation.ok) {
      return jsonResponse({ error: "invalid_config", detail: validation.detail }, 400);
    }
    config = validation.config;
  }

  const record: BuiltinConfigRecord = {
    schemaVersion: 1,
    revision: nextRevision,
    updatedAt: new Date().toISOString(),
    config,
  };
  await env.MIKIKO_BUILTIN_CONFIG.put(BUILTIN_CURRENT_KEY, JSON.stringify(record));
  await env.MIKIKO_BUILTIN_CONFIG.put(
    `${BUILTIN_REVISION_PREFIX}${nextRevision}`,
    JSON.stringify(record),
  );
  return jsonResponse({ ok: true, revision: nextRevision });
}

async function handleAdminBuiltinHistory(env: Env): Promise<Response> {
  const list = await env.MIKIKO_BUILTIN_CONFIG.list({ prefix: BUILTIN_REVISION_PREFIX });
  const entries = list.keys
    .map((key) => {
      const revision = Number.parseInt(key.name.slice(BUILTIN_REVISION_PREFIX.length), 10);
      return Number.isInteger(revision) ? revision : null;
    })
    .filter((revision): revision is number => revision !== null)
    .sort((a, b) => b - a)
    .slice(0, 50)
    .map((revision) => ({ revision, key: `${BUILTIN_REVISION_PREFIX}${revision}` }));
  const current = await readCurrentBuiltin(env);
  return jsonResponse({
    currentRevision: current?.revision ?? null,
    entries,
  });
}

async function handleAdminGetClientConfigs(env: Env): Promise<Response> {
  const stored = await env.MIKIKO_CLIENT_CONFIG.get(CLIENT_CONFIGS_KEY, "json");
  return jsonResponse(stored ?? DEFAULT_CLIENT_CONFIGS);
}

async function handleAdminPutClientConfigs(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  const merged = { ...DEFAULT_CLIENT_CONFIGS, ...(body as object) } as ClientConfigs;
  const mode = merged.dynamicWorkflow?.mode;
  if (typeof mode !== "string" || !DYNAMIC_WORKFLOW_MODES.has(mode)) {
    return jsonResponse(
      { error: "invalid_dynamic_workflow_mode", allowed: [...DYNAMIC_WORKFLOW_MODES] },
      400,
    );
  }
  const limit = merged.share?.publishPerMinutePerIp;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < SHARE_RATE_LIMIT_MIN ||
    limit > SHARE_RATE_LIMIT_MAX
  ) {
    return jsonResponse(
      { error: "invalid_share_rate_limit", min: SHARE_RATE_LIMIT_MIN, max: SHARE_RATE_LIMIT_MAX },
      400,
    );
  }
  const normalized: ClientConfigs = {
    dynamicWorkflow: { mode },
    share: { publishPerMinutePerIp: limit },
  };
  await env.MIKIKO_CLIENT_CONFIG.put(CLIENT_CONFIGS_KEY, JSON.stringify(normalized));
  return jsonResponse({ ok: true, configs: normalized });
}

async function readCurrentBuiltin(env: Env): Promise<BuiltinConfigRecord | null> {
  // KV 读异常不吞（review S3）：若把读失败当「未初始化」，管理端发布会以 revision=1
  // 覆盖 current，已缓存更高 revision 的客户端将永久忽略后续更新。读失败由外层
  // 统一回 500，发布与公开读取双双拒绝。
  const record = await env.MIKIKO_BUILTIN_CONFIG.get(BUILTIN_CURRENT_KEY, "json");
  if (record == null) return null;
  return record as BuiltinConfigRecord;
}

/**
 * 服务端结构校验（防线一；客户端 decodeZCodeBuiltinRelease 是防线二）：
 * config 只允许两键、均为对象、序列化限长、不得包含退役 provider 标识。
 */
function validateBuiltinConfig(input: unknown):
  | {
      ok: true;
      config: { providerConfigRules: unknown; modelConfigRules: unknown };
    }
  | { ok: false; detail: string } {
  if (typeof input !== "object" || input === null) {
    return { ok: false, detail: "config 必须是对象" };
  }
  const keys = Object.keys(input);
  keys.sort();
  if (keys.length !== 2 || keys[0] !== "modelConfigRules" || keys[1] !== "providerConfigRules") {
    return { ok: false, detail: "config 只允许 providerConfigRules 与 modelConfigRules 两键" };
  }
  const config = input as { providerConfigRules: unknown; modelConfigRules: unknown };
  for (const value of [config.providerConfigRules, config.modelConfigRules]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, detail: "规则必须是对象" };
    }
  }
  const serialized = JSON.stringify(config);
  if (serialized.length > BUILTIN_CONFIG_MAX_BYTES) {
    return { ok: false, detail: `配置超过大小上限（${BUILTIN_CONFIG_MAX_BYTES} 字节）` };
  }
  // 粗粒度防线：退役 provider 的 Release 会被客户端整份拒绝，发布前直接拦下。
  if (serialized.includes("builtin:zapi")) {
    return { ok: false, detail: "配置包含已退役 provider（builtin:zapi）" };
  }
  return { ok: true, config };
}

async function isAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MIKIKO_ADMIN_SESSION_SECRET) return false;
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return false;
  const token = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (!token) return false;
  return verifySessionToken(token, env.MIKIKO_ADMIN_SESSION_SECRET);
}

function parseCookieValue(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

/** payload = base64url(expiresAt)；token = payload.base64url(hmac-sha256(secret, payload))。 */
async function signSessionToken(expiresAt: number, secret: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ exp: expiresAt })));
  const signature = await hmacSha256(secret, payload);
  return `${payload}.${signature}`;
}

async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  const separator = token.lastIndexOf(".");
  if (separator === -1) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await hmacSha256(secret, payload);
  if (!(await timingSafeEqualString(signature, expected))) return false;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number" && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

/** 恒定时间字符串比较：先比较摘要长度与内容，避免逐字符短路泄露时序信息。 */
async function timingSafeEqualString(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
