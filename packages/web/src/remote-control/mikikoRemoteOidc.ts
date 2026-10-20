/**
 * remote.mikiko.ai 的 Mikiko ID（KeyCloak OIDC）登录与设备直连（方案 E.5）。
 *
 * 路由：/remote/devices（登录后设备列表 + 发起远控）。
 * OIDC client：mikiko_remote（Public + PKCE S256），回调 /remote/devices/callback。
 * 与 zai/bigmodel 的 provider 体系（renderer↔host OAuth）不同：本页直接用浏览器 fetch
 * 完成 OIDC 授权码流，token 仅存内存（页面刷新走静默授权），无 refresh token 落盘。
 */

export const MIKIKO_REMOTE_OIDC_ISSUER = "https://oauth.mikiko.ai/realms/mikiko";
export const MIKIKO_REMOTE_OIDC_CLIENT_ID = "mikiko_remote";
const OIDC_SCOPE = "openid email profile";

// ── PKCE + state（CSRF）──

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export async function generateRemotePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(64));
  const codeVerifier = base64Url(random);
  const codeChallenge = base64Url(await sha256(codeVerifier));
  return { codeVerifier, codeChallenge };
}

export function generateRemoteState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function buildRemoteAuthorizeUrl(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  issuer?: string;
  clientId?: string;
}): string {
  const url = new URL(
    `${params.issuer ?? MIKIKO_REMOTE_OIDC_ISSUER}/protocol/openid-connect/auth`,
  );
  url.searchParams.set("client_id", params.clientId ?? MIKIKO_REMOTE_OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OIDC_SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ── Token 交换 ──

export interface RemoteOidcTokens {
  accessToken: string;
  idToken: string;
  expiresIn: number;
}

export async function exchangeRemoteCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  issuer?: string;
}): Promise<RemoteOidcTokens> {
  const issuer = params.issuer ?? MIKIKO_REMOTE_OIDC_ISSUER;
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: MIKIKO_REMOTE_OIDC_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`KeyCloak token exchange failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    access_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!body.access_token || !body.id_token) {
    throw new Error("KeyCloak token response missing tokens");
  }
  return {
    accessToken: body.access_token,
    idToken: body.id_token,
    expiresIn: body.expires_in ?? 300,
  };
}

// ── relay API（Bearer = KeyCloak access token）──

export interface RemoteDeviceInfo {
  mid: string;
  name: string;
  appVersion: string;
  lastSeenAt: number;
  online: boolean;
}

export async function listRemoteDevices(
  accessToken: string,
  relayHttpBase: string,
): Promise<RemoteDeviceInfo[]> {
  const response = await fetch(`${relayHttpBase}/api/rc/account/devices`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`List devices failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { devices?: RemoteDeviceInfo[] };
  return body.devices ?? [];
}

export interface RemoteConnectResult {
  sid: string;
  sessionToken: string;
  relayWsBase: string;
}

export async function connectRemoteDevice(
  accessToken: string,
  relayHttpBase: string,
  mid: string,
): Promise<RemoteConnectResult> {
  const response = await fetch(`${relayHttpBase}/api/rc/account/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ mid }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Connect failed: HTTP ${response.status}`);
  }
  return (await response.json()) as RemoteConnectResult;
}

// ── session storage（内存级；页面刷新重走静默授权）──

const SESSION_KEY = "mikiko_remote_oidc_session";

export function storeRemoteSession(tokens: RemoteOidcTokens): void {
  // sessionStorage：同一标签页内跨路由保留；关闭标签页即清（不落持久存储）。
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ ...tokens, storedAt: Date.now() }),
  );
}

export function loadRemoteSession(): RemoteOidcTokens | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemoteOidcTokens & { storedAt: number };
    // 简单过期判定：access token 有效期内可用。
    if (Date.now() > parsed.storedAt + parsed.expiresIn * 1000) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearRemoteSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── PKCE verifier / state 的会话级暂存 ──

const PENDING_KEY = "mikiko_remote_oidc_pending";

export function storePendingAuth(params: { state: string; codeVerifier: string }): void {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(params));
}

export function loadPendingAuth(): { state: string; codeVerifier: string } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { state: string; codeVerifier: string };
  } catch {
    return null;
  }
}

export function clearPendingAuth(): void {
  sessionStorage.removeItem(PENDING_KEY);
}
