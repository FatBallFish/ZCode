import assert from "node:assert/strict";
import test from "node:test";

import {
  base64UrlNoPadDecode,
  base64UrlNoPadEncode,
  buildChatGPTAuthorizeUrl,
  generateChatGPTPkce,
  generateChatGPTState,
  parseChatGPTAccessTokenExpiresAt,
  parseChatGPTIdTokenClaims,
  parseSub2ApiAccountExport,
} from "../src/chatgpt-oauth.js";
import {
  CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  buildChatGPTAccountProviderId,
  buildCodexIdentityHeaders,
  buildCodexUserAgent,
  classifyChatGPTRefreshFailure,
  isChatGPTAccountProviderId,
  isChatGPTBackendHost,
  isChatGPTCloudflareCookieName,
  parseChatGPTAccountProviderId,
} from "../src/chatgpt-account.js";

function encodeJwt(payload: object): string {
  const header = base64UrlNoPadEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256" })));
  const body = base64UrlNoPadEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.signature`;
}

test("PKCE 采用官方 base64url-nopad 口径（64B verifier，S256 challenge）", async () => {
  const { codeVerifier, codeChallenge } = await generateChatGPTPkce();
  assert.equal(codeVerifier.length, 86, "64 字节 base64url 无 padding 应为 86 字符");
  assert.ok(!/[+/=]/u.test(codeVerifier), "verifier 不应包含 + / =");
  assert.equal(codeChallenge.length, 43, "SHA256 base64url 无 padding 应为 43 字符");
  const state = await generateChatGPTState();
  assert.equal(state.length, 43, "32 字节 base64url 无 padding 应为 43 字符");
});

test("授权 URL 包含官方必填参数与扩展参数", async () => {
  const url = new URL(buildChatGPTAuthorizeUrl({ state: "st", codeChallenge: "ch" }));
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/oauth/authorize");
  const params = url.searchParams;
  assert.equal(params.get("client_id"), CHATGPT_OAUTH_CLIENT_ID);
  assert.equal(params.get("redirect_uri"), CHATGPT_OAUTH_REDIRECT_URI);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("id_token_add_organizations"), "true");
  assert.equal(params.get("codex_cli_simplified_flow"), "true");
  assert.equal(params.get("originator"), "codex_cli_rs");
});

test("id_token claims 解析：email 兜底与 auth 嵌套 claim", () => {
  const idToken = encodeJwt({
    email: "user@example.com",
    "https://api.openai.com/profile": { email: "profile@example.com" },
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc-1",
      chatgpt_user_id: "user-1",
      chatgpt_plan_type: "pro",
      chatgpt_account_is_fedramp: false,
    },
    exp: 1893456000,
  });
  const claims = parseChatGPTIdTokenClaims(idToken);
  assert.ok(claims);
  assert.equal(claims.email, "user@example.com", "顶层 email 优先");
  assert.equal(claims.accountId, "acc-1");
  assert.equal(claims.planType, "pro");
  assert.ok(claims.expiresAt);

  const noTopEmail = encodeJwt({
    "https://api.openai.com/profile": { email: "profile@example.com" },
  });
  assert.equal(parseChatGPTIdTokenClaims(noTopEmail)?.email, "profile@example.com");

  assert.equal(parseChatGPTIdTokenClaims("not-a-jwt"), null);
});

test("access_token exp 解析失败返回 undefined（走 lastRefresh 兜底）", () => {
  assert.equal(parseChatGPTAccessTokenExpiresAt(encodeJwt({})), undefined);
  const exp = 1893456000; // 2030-01-01T00:00:00Z
  assert.equal(parseChatGPTAccessTokenExpiresAt(encodeJwt({ exp })), "2030-01-01T00:00:00.000Z");
});

test("刷新失败定级：Permanent 仅限 401 / invalid_grant / 轮换错误码", () => {
  assert.deepEqual(classifyChatGPTRefreshFailure({ status: 401 }), {
    kind: "permanent",
    reason: "unauthorized",
  });
  assert.deepEqual(classifyChatGPTRefreshFailure({ status: 400, errorCode: "invalid_grant" }), {
    kind: "permanent",
    reason: "invalid_grant",
  });
  assert.deepEqual(
    classifyChatGPTRefreshFailure({ errorCode: "refresh_token_reused" }).kind,
    "permanent",
  );
  assert.deepEqual(classifyChatGPTRefreshFailure({ status: 503 }).kind, "transient");
  assert.deepEqual(classifyChatGPTRefreshFailure({}).kind, "transient");
});

test("sub2api 导出解析：仅取 openai+oauth，忽略 proxies/extra/model_mapping", () => {
  const jwt = encodeJwt({
    email: "import@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-import" },
  });
  const result = parseSub2ApiAccountExport({
    exported_at: "2026-10-11T00:00:00Z",
    proxies: [{ id: 1, url: "http://secret" }],
    accounts: [
      {
        name: "from-测试",
        platform: "openai",
        type: "oauth",
        credentials: {
          access_token: jwt,
          refresh_token: "rt.1.abc",
          chatgpt_account_id: "acc-import",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          email: "import@example.com",
          expires_at: "2026-10-19T13:36:30+08:00",
          plan_type: "pro",
          model_mapping: { "gpt-5.4": "gpt-5.4" },
        },
        extra: { codex_5h_used_percent: 10, proxies: "ignored" },
        concurrency: 10,
        auto_pause_on_expired: true,
      },
      {
        name: "非 openai",
        platform: "anthropic",
        type: "oauth",
        credentials: { refresh_token: "x" },
      },
      {
        name: "缺 refresh_token",
        platform: "openai",
        type: "oauth",
        credentials: { chatgpt_account_id: "acc-2" },
      },
      {
        name: "缺 account id",
        platform: "openai",
        type: "oauth",
        credentials: { refresh_token: "y" },
      },
    ],
  });
  assert.equal(result.accounts.length, 1);
  const [account] = result.accounts;
  assert.ok(account);
  assert.equal(account.accountId, "acc-import");
  assert.equal(account.refreshToken, "rt.1.abc");
  assert.equal(account.email, "import@example.com");
  assert.ok(account.accessTokenExpiresAt, "exp 优先于 expires_at 兜底");
  assert.equal(result.skipped.length, 3);
  assert.ok(result.skipped.some((entry) => entry.reason === "not-chatgpt-oauth"));
  assert.ok(result.skipped.some((entry) => entry.reason === "missing-refresh-token"));
  assert.ok(result.skipped.some((entry) => entry.reason === "missing-chatgpt-account-id"));
});

test("provider id 构造与解析", () => {
  const providerId = buildChatGPTAccountProviderId("acc-9");
  assert.ok(providerId.startsWith(CHATGPT_ACCOUNT_PROVIDER_ID_PREFIX));
  assert.equal(parseChatGPTAccountProviderId(providerId), "acc-9");
  assert.equal(parseChatGPTAccountProviderId("account:bigmodel-start-plan"), null);
  assert.equal(isChatGPTAccountProviderId(providerId), true);
});

test("CF cookie 白名单与 host 判定", () => {
  assert.equal(isChatGPTCloudflareCookieName("__cf_bm"), true);
  assert.equal(isChatGPTCloudflareCookieName("__oailb"), true);
  assert.equal(isChatGPTCloudflareCookieName("cf_chl_1"), true);
  assert.equal(isChatGPTCloudflareCookieName("_session"), false);
  assert.equal(isChatGPTBackendHost("chatgpt.com"), true);
  assert.equal(isChatGPTBackendHost("api.chatgpt.com"), true);
  assert.equal(isChatGPTBackendHost("auth.openai.com"), false);
});

test("Codex 身份头：UA 格式与模拟关闭分支", () => {
  const input = {
    codexVersion: "0.146.0",
    osType: "Darwin",
    osVersion: "25.3.0",
    arch: "arm64",
    terminalToken: "Mikiko/1.0.0",
    uaSimulation: true,
    appVersion: "1.0.0",
  };
  assert.equal(
    buildCodexUserAgent(input),
    "codex_cli_rs/0.146.0 (Darwin 25.3.0; arm64; Mikiko/1.0.0)",
  );
  const headers = buildCodexIdentityHeaders(input);
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers.version, "0.146.0");
  const off = buildCodexIdentityHeaders({ ...input, uaSimulation: false });
  assert.equal(off["user-agent"], "Mikiko/1.0.0");
  assert.equal(off.version, undefined);
});

test("base64url 编解码往返", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlNoPadEncode(bytes);
  assert.ok(!/[+/=]/u.test(encoded));
  assert.deepEqual(Array.from(base64UrlNoPadDecode(encoded)), Array.from(bytes));
});
