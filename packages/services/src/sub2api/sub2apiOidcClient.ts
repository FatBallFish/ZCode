import { createHash, randomBytes } from "node:crypto";
import {
  startLoopbackOAuthListener,
  type LoopbackOAuthListener,
} from "../oauth/loopbackCallbackListener.js";

/**
 * MikikoCC 的 Mikiko ID（KeyCloak OIDC）登录客户端：纯 IO 适配层，不做账号事实写入。
 * 链路（docs/mikiko-id-integration-plan.md Part A）：授权码 + PKCE S256（Public client，
 * 无 secret）→ id_token → mikiko.cc token-exchange 换平台 token pair。
 * 出站请求经 request 注入：生产为 host API 网络 transport（httpProxy/CA 生效），
 * 缺省裸 fetch 仅供测试。
 */

/** 线上身份源（KeyCloak 对接文档 §2）；env 覆盖仅供本地联调。 */
export const MIKIKO_OIDC_ISSUER =
  process.env.ZCODE_MIKIKO_OIDC_ISSUER?.trim() ||
  "https://oauth.mikiko.ai/realms/mikiko";
export const MIKIKO_OIDC_CLIENT_ID =
  process.env.ZCODE_MIKIKO_OIDC_CLIENT_ID?.trim() || "mikiko_code";
/** offline_access：取 KeyCloak offline refresh token，供远控/反馈身份使用（Part E/F）。 */
export const MIKIKO_OIDC_SCOPE = "openid email profile offline_access";
export const MIKIKO_OIDC_CALLBACK_PATH = "/callback";
/** 回调等待窗口（KeyCloak 对接文档 §3.2：60–120s 超时即作废本次 state/verifier）。 */
export const MIKIKO_OIDC_AUTHORIZATION_TIMEOUT_MS = 120_000;
const OIDC_REQUEST_TIMEOUT_MS = 20_000;

export class MikikoOidcError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MikikoOidcError";
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function generateOidcState(): string {
  return base64Url(randomBytes(32));
}

export function generateOidcNonce(): string {
  return base64Url(randomBytes(32));
}

/** PKCE S256：verifier 43–128 位（base64url(64B) = 86 位），绝不外发 challenge 之外的值。 */
export function generateOidcPkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64Url(randomBytes(64));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function buildMikikoOidcAuthorizeUrl(params: {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  issuer?: string;
  clientId?: string;
}): string {
  const issuer = params.issuer ?? MIKIKO_OIDC_ISSUER;
  const clientId = params.clientId ?? MIKIKO_OIDC_CLIENT_ID;
  const url = new URL(`${issuer}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", MIKIKO_OIDC_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface MikikoOidcIdTokenClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  iss: string;
  nonce?: string;
}

function decodeJwtPayload(idToken: string): Record<string, unknown> {
  const segments = idToken.split(".");
  if (segments.length < 2) {
    throw new MikikoOidcError("id_token 格式无效", "invalid-id-token");
  }
  try {
    return JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new MikikoOidcError("id_token payload 解码失败", "invalid-id-token");
  }
}

/**
 * 解码校验 id_token payload（不做本地 JWKS 验签——token-exchange 端点强制验签
 * fail-close；此处只做防重放 nonce 比对与 issuer 一致性、提取 sub/email）。
 */
export function parseMikikoOidcIdToken(
  idToken: string,
  options: { issuer?: string; expectedNonce?: string },
): MikikoOidcIdTokenClaims {
  const issuer = options.issuer ?? MIKIKO_OIDC_ISSUER;
  const payload = decodeJwtPayload(idToken);
  if (payload.iss !== issuer) {
    throw new MikikoOidcError("id_token issuer 不一致", "issuer-mismatch");
  }
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : "";
  if (!sub) {
    throw new MikikoOidcError("id_token 缺少 sub", "invalid-id-token");
  }
  if (options.expectedNonce !== undefined && payload.nonce !== options.expectedNonce) {
    throw new MikikoOidcError("id_token nonce 不一致（防重放校验失败）", "nonce-mismatch");
  }
  return {
    sub,
    ...(typeof payload.email === "string" && payload.email ? { email: payload.email } : {}),
    ...(payload.email_verified === true ? { emailVerified: true } : {}),
    iss: payload.iss as string,
    ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}),
  };
}

export interface MikikoOidcCodeExchange {
  idToken: string;
  accessToken?: string;
  /** offline refresh token（scope 含 offline_access 时返回）；不落明文盘，经加密凭据库存。 */
  refreshToken?: string;
  expiresIn?: number;
}

async function postTokenEndpoint(
  body: URLSearchParams,
  params: { issuer?: string; request?: typeof fetch },
): Promise<Record<string, unknown>> {
  const issuer = params.issuer ?? MIKIKO_OIDC_ISSUER;
  let response: Response;
  try {
    response = await (params.request ?? fetch)(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MikikoOidcError(
      `KeyCloak token 端点网络错误: ${error instanceof Error ? error.message : String(error)}`,
      "network",
    );
  }
  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new MikikoOidcError(`KeyCloak token 端点响应无效: HTTP ${response.status}`, "network");
  }
  if (!response.ok) {
    const errorCode = typeof json.error === "string" ? json.error : undefined;
    throw new MikikoOidcError(
      typeof json.error_description === "string" && json.error_description
        ? json.error_description
        : `KeyCloak token 端点失败: HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`,
      errorCode === "invalid_grant" ? "invalid_grant" : "token-endpoint-error",
      response.status,
    );
  }
  return json;
}

/** 授权码换 token（Public client：无 client_secret，仅 PKCE verifier）。 */
export async function exchangeMikikoOidcCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  issuer?: string;
  clientId?: string;
  request?: typeof fetch;
}): Promise<MikikoOidcCodeExchange> {
  const clientId = params.clientId ?? MIKIKO_OIDC_CLIENT_ID;
  const json = await postTokenEndpoint(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: clientId,
      code_verifier: params.codeVerifier,
    }),
    params,
  );
  const idToken = typeof json.id_token === "string" && json.id_token ? json.id_token : "";
  if (!idToken) {
    throw new MikikoOidcError("KeyCloak 响应缺少 id_token", "token-endpoint-error");
  }
  return {
    idToken,
    ...(typeof json.access_token === "string" && json.access_token
      ? { accessToken: json.access_token }
      : {}),
    ...(typeof json.refresh_token === "string" && json.refresh_token
      ? { refreshToken: json.refresh_token }
      : {}),
    ...(typeof json.expires_in === "number" ? { expiresIn: json.expires_in } : {}),
  };
}

export interface MikikoOidcRefreshExchange {
  accessToken: string;
  /** KeyCloak 开了 refresh token 轮换时返回新值，调用方必须覆盖存储。 */
  refreshToken?: string;
  expiresIn?: number;
}

/** offline refresh token 换短时 access token（Part E 设备认领 / Part F 反馈身份）。 */
export async function refreshMikikoOidcToken(params: {
  refreshToken: string;
  issuer?: string;
  clientId?: string;
  request?: typeof fetch;
}): Promise<MikikoOidcRefreshExchange> {
  const clientId = params.clientId ?? MIKIKO_OIDC_CLIENT_ID;
  const json = await postTokenEndpoint(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: clientId,
    }),
    params,
  );
  const accessToken = typeof json.access_token === "string" && json.access_token ? json.access_token : "";
  if (!accessToken) {
    throw new MikikoOidcError("KeyCloak 刷新响应缺少 access_token", "token-endpoint-error");
  }
  return {
    accessToken,
    ...(typeof json.refresh_token === "string" && json.refresh_token
      ? { refreshToken: json.refresh_token }
      : {}),
    ...(typeof json.expires_in === "number" ? { expiresIn: json.expires_in } : {}),
  };
}

export interface MikikoPlatformTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

/**
 * 信任转移：id_token → mikiko.cc 平台 token pair。
 * 响应为裸 JSON（无 {code,data} 信封，sub2api writeOAuthTokenPairResponse 口径），
 * 不能走 panelRequest 的信封解析；错误体 {error, message} 映射为 MikikoOidcError。
 */
export async function exchangeMikikoIdTokenForPlatformTokens(params: {
  panelBaseUrl: string;
  idToken: string;
  request?: typeof fetch;
}): Promise<MikikoPlatformTokenPair> {
  let response: Response;
  try {
    response = await (params.request ?? fetch)(
      `${params.panelBaseUrl}/api/v1/auth/oauth/oidc/token-exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ id_token: params.idToken }),
        signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new MikikoOidcError(
      `token-exchange 网络错误: ${error instanceof Error ? error.message : String(error)}`,
      "network",
    );
  }
  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new MikikoOidcError(`token-exchange 响应无效: HTTP ${response.status}`, "network");
  }
  if (!response.ok) {
    const errorCode = typeof json.error === "string" && json.error ? json.error : undefined;
    const message =
      typeof json.message === "string" && json.message
        ? json.message
        : `token-exchange 失败: HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`;
    throw new MikikoOidcError(message, errorCode ?? "token-exchange-error", response.status);
  }
  const accessToken = typeof json.access_token === "string" && json.access_token ? json.access_token : "";
  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new MikikoOidcError("token-exchange 响应缺少 token pair", "token-exchange-error");
  }
  return {
    accessToken,
    refreshToken,
    ...(typeof json.expires_in === "number" ? { expiresIn: json.expires_in } : {}),
  };
}

/** loopback 回调监听（随机端口）；语义同通用监听器，超时取 120s。 */
export function startMikikoOidcCallbackListener(params: {
  expectedState: string;
  onCode: (code: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<LoopbackOAuthListener> {
  return startLoopbackOAuthListener({
    expectedState: params.expectedState,
    onCode: params.onCode,
    port: 0,
    path: MIKIKO_OIDC_CALLBACK_PATH,
    timeoutMs: params.timeoutMs ?? MIKIKO_OIDC_AUTHORIZATION_TIMEOUT_MS,
  });
}
