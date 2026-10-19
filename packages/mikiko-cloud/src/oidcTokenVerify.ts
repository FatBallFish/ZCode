/**
 * Mikiko ID（KeyCloak）OIDC access token 验签（mikiko-cloud Worker 侧）。
 *
 * 手写 WebCrypto 实现（方案 §13.6 裁定：不引 jose，保持零额外依赖）：
 * discovery → jwks_uri 拉取并按 issuer 缓存（TTL 10 分钟，kid 未命中强制刷新一次），
 * RS256（RSASSA-PKCS1-v1_5 + SHA-256）验签，校验 iss / azp（缺省 aud[0]）/ exp。
 * 仅作身份断言来源：sub 为账号唯一键（不建用户表，方案 F.2）。
 */

export class MikikoOidcAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "MikikoOidcAuthError";
  }
}

/** 允许携带反馈身份的 KeyCloak client（mikiko_remote 的 token 不用于反馈）。 */
export const MIKIKO_OIDC_FEEDBACK_ALLOWED_CLIENTS = ["mikiko_code"] as const;

interface CachedJwks {
  keys: Array<Record<string, unknown>>;
  expiresAt: number;
}

const JWKS_CACHE_TTL_MS = 10 * 60_000;
const jwksCache = new Map<string, CachedJwks>();

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  try {
    const json = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new MikikoOidcAuthError("token 格式无效", 401, "oidc_token_invalid");
  }
}

async function fetchJwks(issuer: string, forceRefresh: boolean): Promise<CachedJwks> {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached;
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  }).then((response) => {
    if (!response.ok) throw new MikikoOidcAuthError("discovery 拉取失败", 502, "oidc_discovery_failed");
    return response.json() as Promise<{ jwks_uri?: string }>;
  });
  const jwksUri = discovery.jwks_uri?.trim();
  if (!jwksUri) throw new MikikoOidcAuthError("discovery 缺少 jwks_uri", 502, "oidc_discovery_failed");
  const jwks = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) }).then((response) => {
    if (!response.ok) throw new MikikoOidcAuthError("jwks 拉取失败", 502, "oidc_jwks_failed");
    return response.json() as Promise<{ keys?: Array<Record<string, unknown>> }>;
  });
  const next: CachedJwks = { keys: jwks.keys ?? [], expiresAt: Date.now() + JWKS_CACHE_TTL_MS };
  jwksCache.set(issuer, next);
  return next;
}

async function verifySignature(
  issuer: string,
  token: string,
  header: Record<string, unknown>,
  payloadSegment: string,
  signatureSegment: string,
): Promise<void> {
  const kid = typeof header.kid === "string" ? header.kid : "";
  const algorithm = header.alg === "RS256" ? "RS256" : "";
  if (!algorithm) throw new MikikoOidcAuthError("仅支持 RS256", 401, "oidc_token_invalid");
  const findKey = (jwks: CachedJwks) =>
    jwks.keys.find((key) => key.kid === kid && key.kty === "RSA" && typeof key.n === "string") ?? null;
  let jwks = await fetchJwks(issuer, false);
  let jwk = findKey(jwks);
  if (jwk === null) {
    // kid 轮换：强制刷新一次，仍未命中才拒绝。
    jwks = await fetchJwks(issuer, true);
    jwk = findKey(jwks);
  }
  if (jwk === null) throw new MikikoOidcAuthError("jwks 未命中 kid", 401, "oidc_token_invalid");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk as unknown as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${token.split(".")[0]}.${payloadSegment}`);
  const signatureBytes = Uint8Array.from(
    atob(signatureSegment.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
  // 算法名用导入时的规范名（"RS256" 仅 Workers 别名，Node webcrypto 不识别）。
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signatureBytes, data);
  if (!valid) throw new MikikoOidcAuthError("签名校验失败", 401, "oidc_token_invalid");
}

export interface MikikoOidcIdentity {
  sub: string;
  email?: string;
}

/** 解析并校验请求携带的 Mikiko ID access token；缺失/无效统一抛 401。 */
export async function requireMikikoOidcIdentity(
  request: Request,
  issuer: string,
  options?: { allowedClients?: readonly string[] },
): Promise<MikikoOidcIdentity> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new MikikoOidcAuthError("缺少 Mikiko ID 凭据", 401, "oidc_authentication_required");
  const segments = token.split(".");
  if (segments.length !== 3) throw new MikikoOidcAuthError("token 格式无效", 401, "oidc_token_invalid");
  const header = decodeBase64UrlJson(segments[0]!);
  const payload = decodeBase64UrlJson(segments[1]!);
  await verifySignature(issuer, token, header, segments[1]!, segments[2]!);
  if (payload.iss !== issuer) throw new MikikoOidcAuthError("issuer 不一致", 401, "oidc_token_invalid");
  const audience = Array.isArray(payload.aud) ? String(payload.aud[0] ?? "") : typeof payload.aud === "string" ? payload.aud : "";
  const authorizedParty = typeof payload.azp === "string" && payload.azp ? payload.azp : audience;
  const allowed = options?.allowedClients ?? MIKIKO_OIDC_FEEDBACK_ALLOWED_CLIENTS;
  if (!allowed.includes(authorizedParty)) {
    throw new MikikoOidcAuthError("token 受众不在允许清单", 401, "oidc_audience_not_allowed");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    throw new MikikoOidcAuthError("token 已过期", 401, "oidc_token_invalid");
  }
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : "";
  if (!sub) throw new MikikoOidcAuthError("token 缺少 sub", 401, "oidc_token_invalid");
  return { sub, ...(typeof payload.email === "string" && payload.email ? { email: payload.email } : {}) };
}

/** 测试钩子：直接注入 JWKS（绕过网络）。 */
export function __setJwksForTests(issuer: string, keys: Array<Record<string, unknown>>): void {
  jwksCache.set(issuer, { keys, expiresAt: Date.now() + 60_000 });
}
