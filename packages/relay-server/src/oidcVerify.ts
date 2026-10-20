/**
 * Mikiko ID（KeyCloak）OIDC access token 验签（relay 侧，方案 Part E.3）。
 *
 * 零第三方依赖（spec §15.6 单文件纪律）：discovery → jwks_uri 拉取并按 issuer 缓存
 * （TTL 10 分钟，kid 未命中强制刷新一次），WebCrypto RS256（RSASSA-PKCS1-v1_5 +
 * SHA-256）验签，校验 iss / azp（缺省 aud[0]）∈ 允许清单 / exp，提取 sub。
 * 内存 JWKS 注入口仅供单测（__setJwksForTests）。
 */

export const RELAY_OIDC_ALLOWED_CLIENTS = ["mikiko_code", "mikiko_remote"] as const;

export class RelayOidcError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RelayOidcError";
  }
}

export interface RelayOidcIdentity {
  sub: string;
}

interface CachedJwks {
  keys: Array<Record<string, unknown>>;
  expiresAt: number;
}

const JWKS_CACHE_TTL_MS = 10 * 60_000;
const jwksCache = new Map<string, CachedJwks>();

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

async function fetchJwks(issuer: string, forceRefresh: boolean, fetchImpl: typeof fetch): Promise<CachedJwks> {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached;
  const discovery = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  }).then((response) => {
    if (!response.ok) throw new RelayOidcError("discovery 拉取失败", 502, "oidc_discovery_failed");
    return response.json() as Promise<{ jwks_uri?: string }>;
  });
  const jwksUri = discovery.jwks_uri?.trim();
  if (!jwksUri) throw new RelayOidcError("discovery 缺少 jwks_uri", 502, "oidc_discovery_failed");
  const jwks = await fetchImpl(jwksUri, { signal: AbortSignal.timeout(10_000) }).then((response) => {
    if (!response.ok) throw new RelayOidcError("jwks 拉取失败", 502, "oidc_jwks_failed");
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
  fetchImpl: typeof fetch,
): Promise<void> {
  if (header.alg !== "RS256") throw new RelayOidcError("仅支持 RS256", 401, "oidc_token_invalid");
  const kid = typeof header.kid === "string" ? header.kid : "";
  const findKey = (jwks: CachedJwks) =>
    jwks.keys.find((key) => key.kid === kid && key.kty === "RSA" && typeof key.n === "string") ?? null;
  let jwks = await fetchJwks(issuer, false, fetchImpl);
  let jwk = findKey(jwks);
  if (jwk === null) {
    jwks = await fetchJwks(issuer, true, fetchImpl);
    jwk = findKey(jwks);
  }
  if (jwk === null) throw new RelayOidcError("jwks 未命中 kid", 401, "oidc_token_invalid");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk as unknown as import("node:crypto").JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${token.split(".")[0]}.${payloadSegment}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    Uint8Array.from(Buffer.from(signatureSegment, "base64url")),
    data,
  );
  if (!valid) throw new RelayOidcError("签名校验失败", 401, "oidc_token_invalid");
}

/** 校验 Bearer access token；缺失/无效统一抛 RelayOidcError（401）。 */
export async function requireRelayOidcIdentity(
  authorizationHeader: string | null | undefined,
  issuer: string,
  options?: {
    allowedClients?: readonly string[];
    fetchImpl?: typeof fetch;
    now?: () => number;
  },
): Promise<RelayOidcIdentity> {
  const token = (authorizationHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new RelayOidcError("缺少 Mikiko ID 凭据", 401, "oidc_authentication_required");
  const segments = token.split(".");
  if (segments.length !== 3) throw new RelayOidcError("token 格式无效", 401, "oidc_token_invalid");
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeBase64UrlJson(segments[0]!);
    payload = decodeBase64UrlJson(segments[1]!);
  } catch {
    throw new RelayOidcError("token 格式无效", 401, "oidc_token_invalid");
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  await verifySignature(issuer, token, header, segments[1]!, segments[2]!, fetchImpl);
  if (payload.iss !== issuer) throw new RelayOidcError("issuer 不一致", 401, "oidc_token_invalid");
  const audience = Array.isArray(payload.aud)
    ? String(payload.aud[0] ?? "")
    : typeof payload.aud === "string"
      ? payload.aud
      : "";
  const authorizedParty = typeof payload.azp === "string" && payload.azp ? payload.azp : audience;
  const allowed = options?.allowedClients ?? RELAY_OIDC_ALLOWED_CLIENTS;
  if (!allowed.includes(authorizedParty)) {
    throw new RelayOidcError("token 受众不在允许清单", 401, "oidc_audience_not_allowed");
  }
  const now = options?.now ?? Date.now;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now()) {
    throw new RelayOidcError("token 已过期", 401, "oidc_token_invalid");
  }
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : "";
  if (!sub) throw new RelayOidcError("token 缺少 sub", 401, "oidc_token_invalid");
  return { sub };
}

/** 单测注入：直接提供 JWKS（绕过网络）。 */
export function __setJwksForTests(issuer: string, keys: Array<Record<string, unknown>>): void {
  jwksCache.set(issuer, { keys, expiresAt: Date.now() + 60_000 });
}
