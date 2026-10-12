/**
 * ChatGPT OAuth 账号接入：领域类型、常量与身份/失败定级纯函数。
 * 上游行为对齐官方 Codex CLI（codex-rs login crate）；spec 见 specs/desktop/chatgpt-oauth.md。
 * 本文件不承载 OAuth 流程与 usage 解析（见 chatgpt-oauth.ts / chatgpt-usage.ts）。
 */
import { z } from "zod";

/** 官方 Codex CLI 公开 client_id（codex-rs login/src/auth/manager.rs CLIENT_ID）。 */
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CHATGPT_REVOKE_URL = "https://auth.openai.com/oauth/revoke";
/** 官方回调固定端口；被占用时授权流程直接中断（用户裁定，不做 1457 fallback）。 */
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455;
export const CHATGPT_OAUTH_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_OAUTH_REDIRECT_URI = `http://127.0.0.1:${CHATGPT_OAUTH_CALLBACK_PORT}${CHATGPT_OAUTH_CALLBACK_PATH}`;
/** 官方当前 scope（含 connectors；刷新时不带 scope）。 */
export const CHATGPT_OAUTH_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

export const CHATGPT_BACKEND_ORIGIN = "https://chatgpt.com/backend-api";
export const CHATGPT_CODEX_BASE_URL = `${CHATGPT_BACKEND_ORIGIN}/codex`;
export const CHATGPT_ORIGINATOR = "codex_cli_rs";
/** 代码内置版本兜底；运行时优先级：手动覆写 > Mikiko 远端配置 > 本值。
 * 2026-10-12 实测：client_version 是 /codex/models 的内容协商键，0.146.0 只回
 * gpt-5.6 系；跟随官方最新稳定版（0.162.1）才能拿到 gpt-6.x 系。远端配置由
 * mikiko-cloud worker 定时从 GitHub releases 同步（spec §10），本值仅冷启动兜底。 */
export const CODEX_VERSION_FALLBACK = "0.162.1";
export const CHATGPT_IMAGE_MODEL = "gpt-image-2";

/** Registry 动态账号 provider id 前缀（host 投影，每个账号一个 provider）。 */
export const CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX = "account:chatgpt:";

export function buildChatGPTAccountProviderId(accountId: string): string {
  return `${CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX}${accountId}`;
}

export function parseChatGPTAccountProviderId(providerId: string): string | null {
  return providerId.startsWith(CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX)
    ? providerId.slice(CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX.length)
    : null;
}

export function isChatGPTAccountProviderId(providerId: string): boolean {
  return providerId.startsWith(CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX);
}

/**
 * Cloudflare 基础设施 cookie 白名单（官方 chatgpt_cloudflare_cookies.rs 口径）。
 * 仅 chatgpt.com 域、仅 HTTPS 回放；绝不存账号/会话 cookie。
 */
const CHATGPT_CF_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
  "__oailb",
]);

export function isChatGPTCloudflareCookieName(name: string): boolean {
  return CHATGPT_CF_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_");
}

export function isChatGPTBackendHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "chatgpt.com" ||
    normalized.endsWith(".chatgpt.com") ||
    normalized === "chat.openai.com" ||
    normalized.endsWith(".chat.openai.com")
  );
}

// ── 账号记录（host 唯一事实；credentials 仅存加密 credentials.json） ──

export interface ChatGPTAccountCredentials {
  accessToken: string;
  refreshToken: string;
  /** access_token JWT exp（ISO）；缺失时以 lastRefreshAt 8 天兜底判断刷新。 */
  accessTokenExpiresAt?: string;
  lastRefreshAt: string;
  clientId: string;
}

/** 官方 Permanent 刷新失败缓存：同凭证快照直接短路，不反复打刷新接口。 */
export interface ChatGPTPermanentRefreshFailure {
  reason: string;
  at: number;
}

export interface ChatGPTAccountStatus {
  state: "active" | "auth-error";
  reason?: string;
  updatedAt: number;
}

export const chatgptAccountStatusSchema = z
  .object({
    state: z.enum(["active", "auth-error"]),
    reason: z.string().optional(),
    updatedAt: z.number(),
  })
  .strict();

export interface ChatGPTAccountRecord {
  accountId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  credentials: ChatGPTAccountCredentials;
  permanentRefreshFailure?: ChatGPTPermanentRefreshFailure;
  profile: {
    planType?: string;
    planExpiresAt?: string;
    isDefault?: boolean;
    isFedramp: boolean;
  };
  usage?: import("./chatgpt-usage.js").ChatGPTUsageSnapshot;
  resetCredits?: ChatGPTResetCredits;
  models?: { slugs: string[]; etag?: string; updatedAt: string };
  status: ChatGPTAccountStatus;
}

export interface ChatGPTResetCredits {
  availableCount: number;
  credits: Array<{ id?: string; expiresAt?: string; status?: string }>;
}

/** renderer 安全视图：剥离 credentials 与内部缓存字段。 */
export interface ChatGPTAccountView {
  accountId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
  profile: ChatGPTAccountRecord["profile"];
  usage?: ChatGPTAccountRecord["usage"];
  resetCredits?: ChatGPTResetCredits;
  models?: ChatGPTAccountRecord["models"];
  status: ChatGPTAccountStatus;
  hasRefreshFailure: boolean;
}

export function toChatGPTAccountView(record: ChatGPTAccountRecord): ChatGPTAccountView {
  return {
    accountId: record.accountId,
    email: record.email,
    ...(record.displayName ? { displayName: record.displayName } : {}),
    ...(record.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    profile: record.profile,
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.resetCredits ? { resetCredits: record.resetCredits } : {}),
    ...(record.models ? { models: record.models } : {}),
    status: record.status,
    hasRefreshFailure: record.permanentRefreshFailure != null,
  };
}

// ── Codex 身份三元组（originator / user-agent / version） ──

export interface CodexIdentityHeaderInput {
  codexVersion: string;
  osType: string;
  osVersion: string;
  arch: string;
  terminalToken: string;
  /** UA 模拟关闭时使用 Mikiko 自身标识（可能被上游拒绝，UI 注明风险）。 */
  uaSimulation: boolean;
  appVersion: string;
}

function sanitizeUserAgentSegment(value: string): string {
  return value.replace(/[()\r\n;]/g, " ").trim();
}

/** 官方 UA 格式：{originator}/{version} ({os} {osVersion}; {arch}; {terminal})。 */
export function buildCodexUserAgent(input: CodexIdentityHeaderInput): string {
  if (!input.uaSimulation) {
    return `Mikiko/${sanitizeUserAgentSegment(input.appVersion)}`;
  }
  const segment = [
    `${sanitizeUserAgentSegment(input.osType)} ${sanitizeUserAgentSegment(input.osVersion)}`,
    sanitizeUserAgentSegment(input.arch),
    sanitizeUserAgentSegment(input.terminalToken),
  ].join("; ");
  return `${CHATGPT_ORIGINATOR}/${sanitizeUserAgentSegment(input.codexVersion)} (${segment})`;
}

export interface CodexIdentityHeaders {
  originator: string;
  "user-agent": string;
  version?: string;
}

export function buildCodexIdentityHeaders(input: CodexIdentityHeaderInput): CodexIdentityHeaders {
  if (!input.uaSimulation) {
    return { originator: "mikiko", "user-agent": buildCodexUserAgent(input) };
  }
  return {
    originator: CHATGPT_ORIGINATOR,
    "user-agent": buildCodexUserAgent(input),
    version: input.codexVersion,
  };
}

// ── 刷新失败定级（官方 classify_refresh_token_failure 口径） ──

export type ChatGPTRefreshFailureClassification =
  | { kind: "permanent"; reason: string }
  | { kind: "transient"; reason: string };

const PERMANENT_REFRESH_ERROR_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export function classifyChatGPTRefreshFailure(params: {
  status?: number;
  errorCode?: string;
}): ChatGPTRefreshFailureClassification {
  const code = params.errorCode?.toLowerCase();
  if (PERMANENT_REFRESH_ERROR_CODES.has(code ?? "")) {
    return { kind: "permanent", reason: code! };
  }
  if (params.status === 401) {
    return { kind: "permanent", reason: "unauthorized" };
  }
  if (params.status === 400 && code === "invalid_grant") {
    return { kind: "permanent", reason: "invalid_grant" };
  }
  return {
    kind: "transient",
    reason: code ?? (params.status != null ? `http_${params.status}` : "network"),
  };
}

/** 官方口径：exp 前 5 分钟内主动刷新；无 exp 时 lastRefreshAt 超 8 天兜底。 */
export const CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
export const CHATGPT_TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;

export function chatGPTAccountNeedsRefresh(
  record: ChatGPTAccountRecord,
  now = Date.now(),
): boolean {
  const credentials = record.credentials;
  if (credentials.accessTokenExpiresAt) {
    const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
    if (Number.isFinite(expiresAt)) {
      return expiresAt - now <= CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MS;
    }
  }
  const lastRefreshAt = Date.parse(credentials.lastRefreshAt);
  if (!Number.isFinite(lastRefreshAt)) return true;
  return now - lastRefreshAt > CHATGPT_TOKEN_REFRESH_INTERVAL_MS;
}

// ── CLI → host 请求结果上报（协议 interaction 通知载荷） ──

export interface ChatGPTRequestOutcome {
  providerId: string;
  kind: "auth-error" | "usage";
  /** auth-error */
  status?: number;
  errorCode?: string;
  message?: string;
  /** usage */
  usageLimit?: {
    planType?: string;
    resetsAt?: string;
    limitWindowMinutes?: number;
    rateLimitReachedType?: string;
  };
  rateLimitHeaders?: import("./chatgpt-usage.js").ChatGPTRateLimitHeaderSnapshot;
}

// ── sub2api 导入结果（解析逻辑见 chatgpt-oauth.ts） ──

export interface ImportedChatGPTAccountInput {
  accountId: string;
  email: string;
  accessToken?: string;
  refreshToken: string;
  idToken?: string;
  clientId: string;
  accessTokenExpiresAt?: string;
  planType?: string;
}

export interface SkippedSub2ApiAccount {
  name?: string;
  email?: string;
  reason: string;
}
