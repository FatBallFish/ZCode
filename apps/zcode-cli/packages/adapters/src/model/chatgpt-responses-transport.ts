import {
  isChatGPTBackendHost,
  isChatGPTCloudflareCookieName,
  parseChatGPTRateLimitHeaders,
  parseChatGPTUsageLimitBody,
} from "@zcode/shared";
import {
  ChatGPTCurlUnavailableError,
  createChatGPTCurlFetch,
} from "./chatgpt-curl-fetch.js";
import {
  reportChatGPTRequestOutcome,
  shouldReportChatGPTUsage,
} from "./chatgpt-outcome-reporter.js";

/**
 * ChatGPT Responses 传输层（spec specs/desktop/chatgpt-oauth.md §7.2-7.5，官方口径）：
 * - 请求体改写：store:false / stream:true / 裁剪不支持字段 / include 加密 reasoning /
 *   service_tier 策略（x-mikiko-chatgpt-service-tier 私有载体头，消费后剥离）。
 * - Cloudflare cookie 白名单回放（仅 chatgpt.com，官方 cookie jar 口径）。
 * - 错误矩阵上报：401/402/403 → auth-error；429 usage_limit_reached + 限流头 → usage。
 *   403 且响应为 Cloudflare HTML 时豁免（网络层问题，不动账号状态）。
 */

export const CHATGPT_SERVICE_TIER_HEADER = "x-mikiko-chatgpt-service-tier";

/** 进程级 CF cookie 存储（仅白名单名；chatgpt.com 域）。 */
const cfCookies = new Map<string, { value: string; expiresAtMs?: number }>();

interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export function createChatGPTResponsesTransportFetch(options: {
  /** 上报归属的 providerId（account:chatgpt:{accountId}，host 按 accountId 定位账号）。 */
  providerId: string;
  request?: FetchLike;
}): FetchLike {
  // 默认走 curl 子进程通道：undici 默认 TLS 指纹会被 /codex/responses 以伪 401 拒绝
  //（详见 chatgpt-curl-fetch.ts 头注释）；无 curl 环境回退全局 fetch。
  let baseRequest: FetchLike;
  if (options.request) {
    baseRequest = options.request;
  } else {
    const curlFetch = createChatGPTCurlFetch();
    baseRequest = (input, init) =>
      curlFetch(input, init).catch((error: unknown) => {
        if (error instanceof ChatGPTCurlUnavailableError) return fetch(input, init);
        throw error;
      });
  }
  const request = baseRequest;
  const providerId = options.providerId;

  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hostname = safeHostname(url);
    const requestInit = { ...init };
    const headers = normalizeHeaders(requestInit.headers);
    const serviceTier = consumeServiceTierHeader(headers);
    const cookieHeader = cfCookieHeader(hostname);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    if (requestInit.body != null) {
      requestInit.body = transformResponsesBody(requestInit.body, serviceTier);
    }
    requestInit.headers = headers;

    const response = await request(input, requestInit);
    storeCloudflareCookies(hostname, response);
    // 4xx 错误路径（401/402/403/429）统一在 reportErrorOutcome 里带限流头上报，
    // 正常响应只做被动的头族 usage 上报（30s 节流）。
    if (![401, 402, 403, 429].includes(response.status)) {
      reportUsageFromHeaders(providerId, response);
    }
    void reportErrorOutcome(providerId, response);
    return response;
  };
}

/** Responses 请求体改写（官方 applyCodexOAuthTransform 移植口径）。 */
export function transformResponsesBody(body: BodyInit, serviceTier: string | undefined): BodyInit {
  if (typeof body !== "string") return body;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }
  // ChatGPT codex 端点硬性要求：store 必须为 false；OAuth 路径恒流式。
  parsed.store = false;
  parsed.stream = true;
  // 上游拒绝的采样/控制字段（部分是 AI SDK 默认注入值）。
  const unsupportedFields = [
    "max_output_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "user",
    "metadata",
    "stream_options",
    "truncation",
    "stop_sequences",
  ];
  for (const field of unsupportedFields) delete parsed[field];
  // input 必须为数组：字符串包一层用户消息。
  if (typeof parsed.input === "string") {
    parsed.input = [{ type: "message", role: "user", content: parsed.input }];
  }
  if (parsed.reasoning && typeof parsed.reasoning === "object") {
    const include = Array.isArray(parsed.include) ? (parsed.include as string[]) : [];
    if (!include.includes("reasoning.encrypted_content")) {
      parsed.include = [...include, "reasoning.encrypted_content"];
    }
    const reasoning = parsed.reasoning as { effort?: unknown };
    if (reasoning.effort === "minimal") reasoning.effort = "none";
  }
  // service_tier 策略：auto=不发送；fast 归一为官方别名 priority；flex 原样。
  if (serviceTier === "auto" || serviceTier == null) {
    delete parsed.service_tier;
  } else {
    parsed.service_tier = serviceTier === "fast" ? "priority" : serviceTier;
  }
  return JSON.stringify(parsed);
}

// ── 私有工具 ──

function normalizeHeaders(input: HeadersInit | undefined): Headers {
  if (input == null) return new Headers();
  if (input instanceof Headers) {
    const headers = new Headers();
    for (const [name, value] of input.entries()) headers.set(name, value);
    return headers;
  }
  return new Headers(input);
}

function consumeServiceTierHeader(headers: Headers): string | undefined {
  // 大小写不敏感查找私有载体头；消费后必须剥离，不得发往上游。
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase() === CHATGPT_SERVICE_TIER_HEADER) {
      const value = headers.get(name)?.trim() ?? "";
      headers.delete(name);
      return value || undefined;
    }
  }
  return undefined;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function cfCookieHeader(hostname: string): string | undefined {
  if (!isChatGPTBackendHost(hostname)) return undefined;
  const now = Date.now();
  const pairs: string[] = [];
  for (const [name, cookie] of cfCookies) {
    if (cookie.expiresAtMs != null && cookie.expiresAtMs <= now) {
      cfCookies.delete(name);
      continue;
    }
    pairs.push(`${name}=${cookie.value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function storeCloudflareCookies(hostname: string, response: Response): void {
  if (!isChatGPTBackendHost(hostname)) return;
  const setCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (setCookies.length === 0) return;
  const now = Date.now();
  for (const raw of setCookies) {
    const segments = raw.split(";");
    const [namePart, valuePart] = (segments[0] ?? "").trim().split("=");
    const name = namePart?.trim();
    if (!name || !isChatGPTCloudflareCookieName(name)) continue;
    let expiresAtMs: number | undefined;
    for (const attribute of segments.slice(1)) {
      const trimmed = attribute.trim().toLowerCase();
      if (trimmed.startsWith("max-age=")) {
        const seconds = Number(trimmed.slice(8));
        if (Number.isFinite(seconds)) expiresAtMs = now + seconds * 1000;
      } else if (trimmed.startsWith("expires=")) {
        const parsed = Date.parse(attribute.trim().slice(8));
        if (Number.isFinite(parsed)) expiresAtMs = parsed;
      }
    }
    if (!valuePart || !valuePart.trim() || (expiresAtMs != null && expiresAtMs <= now)) {
      cfCookies.delete(name);
      continue;
    }
    cfCookies.set(name, { value: valuePart.trim(), ...(expiresAtMs ? { expiresAtMs } : {}) });
  }
}

function reportUsageFromHeaders(providerId: string, response: Response): void {
  if (!providerId) return;
  const snapshot = parseChatGPTRateLimitHeaders(response.headers);
  if (!snapshot) return;
  if (!shouldReportChatGPTUsage(providerId)) return;
  reportChatGPTRequestOutcome({
    providerId,
    kind: "usage",
    rateLimitHeaders: snapshot,
  });
}

async function reportErrorOutcome(providerId: string, response: Response): Promise<void> {
  if (!providerId) return;
  if (![401, 402, 403, 429].includes(response.status)) return;
  // 响应体可能被上层 SDK 消费；clone 后读取，原响应不受影响。
  const cloned = response.clone();
  let bodyText = "";
  try {
    bodyText = await cloned.text();
  } catch {
    bodyText = "";
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 403 && contentType.includes("text/html")) {
    // Cloudflare/CDN HTML 拦截：网络层问题，不动账号状态（官方豁免口径）。
    return;
  }
  if (response.status === 429) {
    const usageLimit = parseChatGPTUsageLimitBody(bodyText);
    const rateLimitHeaders = parseChatGPTRateLimitHeaders(response.headers);
    if (usageLimit || rateLimitHeaders) {
      reportChatGPTRequestOutcome({
        providerId,
        kind: "usage",
        ...(usageLimit ? { usageLimit } : {}),
        ...(rateLimitHeaders ? { rateLimitHeaders } : {}),
      });
    }
    return;
  }
  let errorCode: string | undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: string; message?: string };
      detail?: string | { message?: string };
    };
    errorCode = parsed.error?.code?.trim() || undefined;
    message = parsed.error?.message ?? (typeof parsed.detail === "string" ? parsed.detail : undefined);
  } catch {
    /* 非 JSON 体（含 Unauthorized 纯文本）按状态码上报 */
  }
  reportChatGPTRequestOutcome({
    providerId,
    kind: "auth-error",
    status: response.status,
    ...(errorCode ? { errorCode } : {}),
    ...(message ? { message: message.slice(0, 200) } : {}),
  });
}
