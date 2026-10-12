/**
 * ChatGPT OAuth 纯函数：PKCE（官方 base64url-nopad 口径）、授权 URL、JWT claims 解析、
 * sub2api 导出解析。无 IO；宿主（host/CLI）与测试共用。
 * 官方参考：codex-rs login/src/oauth/{pkce,authorization}.rs、token_data.rs。
 */
import { z } from "zod";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_SCOPE,
  CHATGPT_ORIGINATOR,
  type ImportedChatGPTAccountInput,
  type SkippedSub2ApiAccount,
} from "./chatgpt-account.js";

// ── base64url 无 padding 编解码（官方 PKCE 编码口径；不用 hex） ──

export function base64UrlNoPadEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function base64UrlNoPadDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary =
    typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export interface ChatGPTPkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

/** 官方口径：verifier = base64url-nopad(64 随机字节)；challenge = base64url-nopad(sha256(verifier ASCII))。 */
export async function generateChatGPTPkce(): Promise<ChatGPTPkceCodes> {
  const codeVerifier = base64UrlNoPadEncode(randomBytes(64));
  const codeChallenge = base64UrlNoPadEncode(await sha256Bytes(codeVerifier));
  return { codeVerifier, codeChallenge };
}

/** state = base64url-nopad(32 随机字节)。 */
export async function generateChatGPTState(): Promise<string> {
  return base64UrlNoPadEncode(randomBytes(32));
}

export function buildChatGPTAuthorizeUrl(params: {
  state: string;
  codeChallenge: string;
  clientId?: string;
  redirectUri?: string;
}): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId ?? CHATGPT_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", params.redirectUri ?? CHATGPT_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // 官方额外参数：组织注入 + 简化授权流 + originator。
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", CHATGPT_ORIGINATOR);
  return url.toString();
}

// ── JWT 解析（不验签，校验 exp；官方 token_data.rs 口径） ──

export interface ChatGPTJwtClaims {
  email?: string;
  accountId?: string;
  userId?: string;
  planType?: string;
  isFedramp: boolean;
  expiresAt?: string;
}

interface ChatGPTJwtAuthClaims {
  chatgpt_account_id?: string;
  chatgpt_user_id?: string;
  user_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_account_is_fedramp?: boolean;
}

interface ChatGPTJwtPayload {
  exp?: number;
  email?: string;
  "https://api.openai.com/profile"?: { email?: string };
  "https://api.openai.com/auth"?: ChatGPTJwtAuthClaims;
}

export function parseChatGPTJwtPayload(jwt: string): ChatGPTJwtPayload | null {
  const segments = jwt.split(".");
  if (segments.length !== 3) return null;
  try {
    const payloadBytes = base64UrlNoPadDecode(segments[1]!);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as ChatGPTJwtPayload;
    return typeof payload === "object" && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

/** id_token → 账号身份（email 顶层优先，profile 兜底；auth 嵌套 claim 取账号信息）。 */
export function parseChatGPTIdTokenClaims(idToken: string): ChatGPTJwtClaims | null {
  const payload = parseChatGPTJwtPayload(idToken);
  if (!payload) return null;
  const auth = payload["https://api.openai.com/auth"];
  const exp = typeof payload.exp === "number" && payload.exp > 0 ? payload.exp : undefined;
  return {
    email: payload.email ?? payload["https://api.openai.com/profile"]?.email,
    accountId: auth?.chatgpt_account_id,
    userId: auth?.chatgpt_user_id ?? auth?.user_id,
    planType: auth?.chatgpt_plan_type,
    isFedramp: auth?.chatgpt_account_is_fedramp === true,
    ...(exp != null ? { expiresAt: new Date(exp * 1000).toISOString() } : {}),
  };
}

/** access_token 的 exp（ISO）；解析失败返回 undefined（走 lastRefreshAt 兜底）。 */
export function parseChatGPTAccessTokenExpiresAt(accessToken: string): string | undefined {
  const payload = parseChatGPTJwtPayload(accessToken);
  if (!payload || typeof payload.exp !== "number" || payload.exp <= 0) return undefined;
  return new Date(payload.exp * 1000).toISOString();
}

// ── sub2api 导出解析（仅取 ChatGPT OAuth 数据；忽略 proxies/extra 等全部其他字段） ──

const sub2ApiCredentialsSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    id_token: z.string().optional(),
    chatgpt_account_id: z.string().optional(),
    chatgpt_user_id: z.string().optional(),
    client_id: z.string().optional(),
    email: z.string().optional(),
    expires_at: z.string().optional(),
    plan_type: z.string().optional(),
  })
  .partial()
  .loose();

const sub2ApiAccountSchema = z
  .object({
    name: z.string().optional(),
    platform: z.string().optional(),
    type: z.string().optional(),
    credentials: sub2ApiCredentialsSchema.optional(),
  })
  .loose();

const sub2ApiExportSchema = z.object({ accounts: z.array(z.unknown()) }).loose();

export interface ParsedSub2ApiAccountExport {
  accounts: ImportedChatGPTAccountInput[];
  skipped: SkippedSub2ApiAccount[];
}

export function parseSub2ApiAccountExport(input: unknown): ParsedSub2ApiAccountExport {
  const result: ParsedSub2ApiAccountExport = { accounts: [], skipped: [] };
  const parsed = sub2ApiExportSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("不是有效的 sub2api 导出文件（缺少 accounts 数组）");
  }
  for (const raw of parsed.data.accounts) {
    const account = sub2ApiAccountSchema.safeParse(raw);
    if (!account.success) {
      result.skipped.push({ reason: "invalid-account" });
      continue;
    }
    const credentials = account.data.credentials ?? {};
    const identity =
      credentials.email ??
      (credentials.id_token ? parseChatGPTIdTokenClaims(credentials.id_token)?.email : undefined);
    if (account.data.platform !== "openai" || account.data.type !== "oauth") {
      result.skipped.push({
        ...(account.data.name ? { name: account.data.name } : {}),
        ...(identity ? { email: identity } : {}),
        reason: "not-chatgpt-oauth",
      });
      continue;
    }
    if (!credentials.refresh_token?.trim() || !credentials.chatgpt_account_id?.trim()) {
      result.skipped.push({
        ...(account.data.name ? { name: account.data.name } : {}),
        ...(identity ? { email: identity } : {}),
        reason: !credentials.chatgpt_account_id?.trim()
          ? "missing-chatgpt-account-id"
          : "missing-refresh-token",
      });
      continue;
    }
    const accessToken = credentials.access_token?.trim();
    result.accounts.push({
      accountId: credentials.chatgpt_account_id.trim(),
      email: identity?.trim() ?? "",
      ...(accessToken ? { accessToken } : {}),
      refreshToken: credentials.refresh_token.trim(),
      ...(credentials.id_token?.trim() ? { idToken: credentials.id_token.trim() } : {}),
      clientId: credentials.client_id?.trim() || CHATGPT_OAUTH_CLIENT_ID,
      ...(accessToken
        ? {
            accessTokenExpiresAt:
              parseChatGPTAccessTokenExpiresAt(accessToken) ??
              normalizeOptionalIso(credentials.expires_at),
          }
        : { accessTokenExpiresAt: normalizeOptionalIso(credentials.expires_at) }),
      ...(credentials.plan_type?.trim() ? { planType: credentials.plan_type.trim() } : {}),
    });
  }
  return result;
}

function normalizeOptionalIso(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
