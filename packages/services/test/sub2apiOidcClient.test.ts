import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MIKIKO_OIDC_ISSUER,
  MIKIKO_OIDC_CLIENT_ID,
  MikikoOidcError,
  buildMikikoOidcAuthorizeUrl,
  exchangeMikikoIdTokenForPlatformTokens,
  exchangeMikikoOidcCode,
  generateOidcPkce,
  parseMikikoOidcIdToken,
  refreshMikikoOidcToken,
  startMikikoOidcCallbackListener,
} from "../src/sub2api/sub2apiOidcClient.js";

/** MikikoCC OIDC 客户端单元（方案 Part A.5 契约口径）。 */

function makeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(payload)}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("PKCE S256：challenge = base64url(sha256(verifier))，verifier 长度合规", () => {
  const { codeVerifier, codeChallenge } = generateOidcPkce();
  assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128);
  assert.equal(codeChallenge, createHash("sha256").update(codeVerifier).digest().toString("base64url"));
  assert.notEqual(codeChallenge, codeVerifier);
});

test("authorize URL 携带完整 OIDC 参数（PKCE S256 + nonce + offline_access）", () => {
  const url = new URL(
    buildMikikoOidcAuthorizeUrl({
      redirectUri: "http://127.0.0.1:49152/callback",
      state: "st",
      nonce: "nc",
      codeChallenge: "ch",
    }),
  );
  assert.equal(url.origin + url.pathname, `${MIKIKO_OIDC_ISSUER}/protocol/openid-connect/auth`);
  assert.equal(url.searchParams.get("client_id"), MIKIKO_OIDC_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:49152/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile offline_access");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("nonce"), "nc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("id_token 解码：iss/nonce/sub 校验（本地不做 JWKS 验签，验签归 token-exchange）", () => {
  const issuer = MIKIKO_OIDC_ISSUER;
  const claims = parseMikikoOidcIdToken(
    makeJwt({ iss: issuer, sub: "user-1", email: "u@mikiko.ai", email_verified: true, nonce: "nc" }),
    { expectedNonce: "nc" },
  );
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.email, "u@mikiko.ai");
  assert.equal(claims.emailVerified, true);
  assert.throws(
    () => parseMikikoOidcIdToken(makeJwt({ iss: "https://evil.test", sub: "x" }), {}),
    /issuer/,
  );
  assert.throws(
    () => parseMikikoOidcIdToken(makeJwt({ iss: issuer, sub: "x", nonce: "a" }), { expectedNonce: "b" }),
    /nonce/,
  );
  assert.throws(() => parseMikikoOidcIdToken(makeJwt({ iss: issuer }), {}), /sub/);
});

test("授权码交换：form-encoded、无 client_secret、缺 id_token 报错", async () => {
  let capturedBody = "";
  const request = (async (_input: unknown, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return jsonResponse({ access_token: "at", id_token: makeJwt({ iss: MIKIKO_OIDC_ISSUER, sub: "s" }), refresh_token: "rt", expires_in: 300 });
  }) as typeof fetch;
  const exchanged = await exchangeMikikoOidcCode({
    code: "c",
    codeVerifier: "v",
    redirectUri: "http://127.0.0.1:1/callback",
    request,
  });
  assert.equal(exchanged.idToken.split(".")[1], makeJwt({ iss: MIKIKO_OIDC_ISSUER, sub: "s" }).split(".")[1]);
  assert.ok(capturedBody.includes("grant_type=authorization_code"));
  assert.ok(capturedBody.includes("code_verifier=v"));
  assert.ok(capturedBody.includes(`client_id=${MIKIKO_OIDC_CLIENT_ID}`));
  assert.ok(!capturedBody.includes("client_secret"));
  await assert.rejects(
    exchangeMikikoOidcCode({ code: "c", codeVerifier: "v", redirectUri: "u", request: (async () => jsonResponse({ access_token: "at" })) as typeof fetch }),
    /id_token/,
  );
});

test("token-exchange：裸 JSON 解析、信封形状不误判、错误码映射", async () => {
  const ok = await exchangeMikikoIdTokenForPlatformTokens({
    panelBaseUrl: "https://panel.test",
    idToken: "idt",
    request: (async () => jsonResponse({ access_token: "pt", refresh_token: "prt", expires_in: 3600, token_type: "Bearer" })) as typeof fetch,
  });
  assert.deepEqual(ok, { accessToken: "pt", refreshToken: "prt", expiresIn: 3600 });

  // 信封形状（sub2api 其它接口的 {code,data} 包装）不得被当作成功解析——该端点是裸 JSON。
  await assert.rejects(
    exchangeMikikoIdTokenForPlatformTokens({
      panelBaseUrl: "https://panel.test",
      idToken: "idt",
      request: (async () => jsonResponse({ code: 0, data: { access_token: "x" } })) as typeof fetch,
    }),
    /缺少 token pair/,
  );

  await assert.rejects(
    exchangeMikikoIdTokenForPlatformTokens({
      panelBaseUrl: "https://panel.test",
      idToken: "idt",
      request: (async () =>
        jsonResponse({ error: "OAUTH_ID_TOKEN_INVALID", message: "id_token audience mismatch" }, 401)) as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MikikoOidcError);
      assert.equal(error.errorCode, "OAUTH_ID_TOKEN_INVALID");
      assert.match(error.message, /audience mismatch/);
      return true;
    },
  );
});

test("offline refresh：成功解析与 invalid_grant 映射（轮换值原样返回由调用方覆盖存储）", async () => {
  let body = "";
  const request = (async (_input: unknown, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 300 });
  }) as typeof fetch;
  const refreshed = await refreshMikikoOidcToken({ refreshToken: "rt-1", request });
  assert.deepEqual(refreshed, { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 300 });
  assert.ok(body.includes("grant_type=refresh_token") && body.includes("refresh_token=rt-1"));
  assert.ok(!body.includes("client_secret"));
  await assert.rejects(
    refreshMikikoOidcToken({
      refreshToken: "rt-1",
      request: (async () => jsonResponse({ error: "invalid_grant", error_description: "Session not active" }, 400)) as typeof fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MikikoOidcError);
      assert.equal(error.errorCode, "invalid_grant");
      return true;
    },
  );
});

test("loopback 监听：随机端口、state 不匹配不消费、正确回调完成、取消语义", async () => {
  let onCodeValue = "";
  const listener = await startMikikoOidcCallbackListener({
    expectedState: "st-1",
    onCode: async (code) => {
      onCodeValue = code;
    },
    timeoutMs: 5_000,
  });
  assert.ok(listener.port > 0);
  const callback = `http://127.0.0.1:${listener.port}/callback`;
  try {
    // 错误 state：返回 400 且不消费（监听保持）。
    const bad = await fetch(`${callback}?code=evil&state=wrong`);
    assert.equal(bad.status, 400);
    const good = await fetch(`${callback}?code=ok-code&state=st-1`);
    assert.equal(good.status, 200);
    const done = await listener.done;
    assert.equal(done.code, "ok-code");
    assert.equal(onCodeValue, "ok-code");
    // 完成后监听关闭。
    await assert.rejects(fetch(callback));
  } finally {
    listener.close();
  }

  // 取消：未 settle 时 close → done reject(cancelled)，不再等待。
  const listener2 = await startMikikoOidcCallbackListener({
    expectedState: "st-2",
    onCode: async () => {},
    timeoutMs: 5_000,
  });
  listener2.close();
  await assert.rejects(listener2.done, /取消/);
});
