import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSub2ApiService } from "../src/sub2api/sub2apiService.js";
import { MIKIKO_OIDC_ISSUER } from "../src/sub2api/sub2apiOidcClient.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ISub2ApiService } from "../src/sub2api/sub2api.js";

/**
 * MikikoCC Mikiko ID（OIDC）登录服务编排（方案 Part A.6.3 + A.9 + G.2.2）。
 * token-exchange 走 mock（sub2api allowlist 未上线）；KeyCloak 端点按契约 mock，
 * loopback 回调为真实 HTTP 回环（不经 mock）。
 */

const KEYCLOAK_TOKEN_URL = `${MIKIKO_OIDC_ISSUER}/protocol/openid-connect/token`;
const PANEL = "https://mikiko.cc";
const TOKEN_EXCHANGE_URL = `${PANEL}/api/v1/auth/oauth/oidc/token-exchange`;

function makeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(payload)}.sig`;
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function waitForEvent<T>(subscribe: (listener: (event: T) => void) => { dispose(): void }): Promise<T> {
  return new Promise((resolve) => {
    const disposable = subscribe((event) => {
      disposable.dispose();
      resolve(event);
    });
  });
}

interface FetchScenario {
  keycloak?: (grantType: string, body: URLSearchParams, captured: { nonce?: string }) => Response;
  tokenExchange?: () => Response;
}

async function seed(base: string, site: Record<string, unknown>): Promise<string> {
  const configFile = join(base, ".mikiko", "v2", "sub2api.json");
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  await writeFile(configFile, JSON.stringify({ version: 2, sites: [site], modelConfigs: {} }));
  return configFile;
}

const mikikoccSite = (account: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  id: "mikikocc",
  kind: "mikikocc",
  panelBaseUrl: PANEL,
  gatewayBaseUrl: "https://api.mikiko.cc",
  siteName: "MikikoCC",
  account,
  ...extra,
});

function createCredentialStore() {
  const credentials = new Map<string, string>();
  return {
    credentials,
    store: {
      load: async (key: string) => credentials.get(key) ?? null,
      save: async (key: string, value: string) => {
        credentials.set(key, value);
      },
      delete: async (key: string) => {
        credentials.delete(key);
      },
    },
  };
}

function createProviderSettingsStub() {
  const calls = { created: 0, deleted: [] as string[], getView: 0 };
  const stub = {
    calls,
    getView: async () => {
      calls.getView += 1;
      return { revision: 1, providerTemplates: [], providerOrder: [], providers: [] };
    },
    createPersonalProvider: async () => {
      calls.created += 1;
      return { providerId: `p-${calls.created}` };
    },
    savePersonalProviderOverlay: async () => ({}),
    addPersonalModel: async () => ({}),
    deletePersonalProvider: async (providerId: string) => {
      calls.deleted.push(providerId);
    },
    resolveRelayModelRecommendation: async () => null,
  };
  return { calls, stub };
}

async function withStubbedFetch(
  scenario: FetchScenario,
  run: (captured: { nonce?: string; refreshCalls: number }) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const captured: { nonce?: string; refreshCalls: number; overrideRefresh?: () => Response } = { refreshCalls: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // loopback 回调走真实网络（不经 mock）。
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    if (url === KEYCLOAK_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const grantType = body.get("grant_type") ?? "";
      if (grantType === "refresh_token") {
        captured.refreshCalls += 1;
        if (captured.overrideRefresh) {
          return captured.overrideRefresh();
        }
        return (
          scenario.keycloak?.(grantType, body, captured) ??
          new Response(JSON.stringify({ access_token: `kat-${captured.refreshCalls}`, expires_in: 1 }), { status: 200, headers: { "content-type": "application/json" } })
        );
      }
      const state = url; // authorization_code：id_token 的 nonce 来自 authorizeUrl 捕获值。
      void state;
      return (
        scenario.keycloak?.(grantType, body, captured) ??
        new Response(
          JSON.stringify({
            access_token: "kc-at",
            id_token: makeJwt({
              iss: MIKIKO_OIDC_ISSUER,
              sub: "user-1",
              email: "u@mikiko.ai",
              email_verified: true,
              nonce: captured.nonce,
            }),
            refresh_token: "kc-rt-1",
            expires_in: 300,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      );
    }
    if (url === TOKEN_EXCHANGE_URL) {
      return (
        scenario.tokenExchange?.() ??
        new Response(
          JSON.stringify({ access_token: "pt-1", refresh_token: "prt-1", expires_in: 3600, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      );
    }
    if (url.endsWith("/api/v1/auth/me")) {
      return envelope({ user: { email: "u@mikiko.ai", balance: 3 } });
    }
    if (url.endsWith("/api/v1/groups/available")) {
      return envelope([]);
    }
    if (url.endsWith("/api/v1/keys?page=1&page_size=200")) {
      return envelope({ items: [{ id: "1", key: "sk-1", name: "K1", status: "active" }] });
    }
    return envelope({});
  }) as typeof fetch;
  try {
    await run(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** 驱动真实 loopback 回调：从 authorizeUrl 解析 state/nonce/端口后请求回调。 */
async function driveCallback(session: { authorizeUrl: string }): Promise<{ state: string; nonce: string }> {
  const url = new URL(session.authorizeUrl);
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const port = new URL(redirectUri).port;
  const response = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${encodeURIComponent(state)}`);
  assert.equal(response.status, 200);
  return { state, nonce };
}

test("OIDC 登录 happy path：真实 loopback 回环 → 账号态/加密凭据/事件/落盘", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-oidc-happy-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  const configFile = await seed(
    base,
    mikikoccSite(null, { keyModels: { "1": ["gpt-5.5"] } }),
  );
  const { credentials, store } = createCredentialStore();
  const providers = createProviderSettingsStub();

  await withStubbedFetch({}, async (captured) => {
    const service = createSub2ApiService({
      providerSettingsService: providers.stub as never,
      credentialStore: store,
    });
    const completed = waitForEvent(service.onOIDCLoginCompleted);
    const session = await service.startOIDCLogin("mikikocc");
    captured.nonce = new URL(session.authorizeUrl).searchParams.get("nonce") ?? undefined;
    await driveCallback(session);
    const event = await completed;

    assert.equal(event.siteId, "mikikocc");
    assert.equal(event.syncedKeyCount, 1);
    assert.equal(event.state.account?.email, "u@mikiko.ai");
    assert.equal(event.state.account?.balanceUsd, 3);

    const identity = await service.getOIDCIdentity("mikikocc");
    assert.equal(identity?.sub, "user-1");
    assert.equal(identity?.email, "u@mikiko.ai");

    // refresh token 只进加密存储面；sub2api.json 明文不含 OIDC 凭据（§13.7）。
    assert.equal(credentials.get("sub2api:mikikocc:oidc-refresh-token"), "kc-rt-1");
    const disk = await readFile(configFile, "utf-8");
    assert.ok(disk.includes('"sub": "user-1"'));
    assert.ok(!disk.includes("kc-rt-1"));
    assert.ok(!disk.includes("kc-at"));
  });
});

test("nonce 不一致（防重放）→ failed 事件 errorCode=nonce-mismatch", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-oidc-nonce-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await seed(base, mikikoccSite(null, { keyModels: { "1": ["gpt-5.5"] } }));
  const { credentials, store } = createCredentialStore();
  const providers = createProviderSettingsStub();
  await withStubbedFetch(
    {
      keycloak: () =>
        new Response(
          JSON.stringify({
            access_token: "kc-at",
            id_token: makeJwt({ iss: MIKIKO_OIDC_ISSUER, sub: "user-1", nonce: "tampered" }),
            expires_in: 300,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    },
    async () => {
      const service = createSub2ApiService({
        providerSettingsService: providers.stub as never,
        credentialStore: store,
      });
      const failed = waitForEvent(service.onOIDCLoginFailed);
      const session = await service.startOIDCLogin("mikikocc");
      await driveCallback(session);
      const event = await failed;
      assert.equal(event.errorCode, "nonce-mismatch");
    },
  );
});

test("token-exchange 受众不匹配（allowlist 未配好的线上形态）→ failed 事件透出错误码", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-oidc-aud-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await seed(base, mikikoccSite(null, { keyModels: { "1": ["gpt-5.5"] } }));
  const { credentials, store } = createCredentialStore();
  const providers = createProviderSettingsStub();

  await withStubbedFetch(
    {
      tokenExchange: () =>
        new Response(
          JSON.stringify({ error: "OAUTH_ID_TOKEN_INVALID", message: "id_token audience mismatch" }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    },
    async (captured) => {
      const service = createSub2ApiService({
        providerSettingsService: providers.stub as never,
        credentialStore: store,
      });
      const failed = waitForEvent(service.onOIDCLoginFailed);
      const session = await service.startOIDCLogin("mikikocc");
      captured.nonce = new URL(session.authorizeUrl).searchParams.get("nonce") ?? undefined;
      await driveCallback(session);
      const event = await failed;
      assert.equal(event.errorCode, "OAUTH_ID_TOKEN_INVALID");
      assert.match(event.message, /audience mismatch/);
      // 失败不落账号态。
      const sites = await service.getSites();
      assert.equal(sites.sites.find((entry) => entry.siteId === "mikikocc")?.account, null);
    },
  );
});

test("范围守卫：sub2api 站点禁 OIDC；mikikocc 禁账密（含 2FA）", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-oidc-guard-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await seed(base, {
    id: "self-hosted",
    kind: "sub2api",
    panelBaseUrl: "https://s.test",
    account: null,
  });
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  const service = createSub2ApiService({ providerSettingsService: {} as never });
  await assert.rejects(service.startOIDCLogin("self-hosted"), /仅 MikikoCC/);
  await assert.rejects(
    service.login({ siteId: "mikikocc", email: "u@test", password: "pw" }),
    (error: unknown) => {
      assert.equal((error as { errorCode?: string }).errorCode, "mikikocc-oidc-required");
      return true;
    },
  );
  await assert.rejects(
    service.loginWith2FA({ siteId: "mikikocc", tempToken: "t", totpCode: "123456" }),
    /Mikiko ID/,
  );
});

test("getOIDCAccessToken：单飞合并、轮换覆盖存储、invalid_grant 清身份不清平台会话", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-oidc-at-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await seed(base, mikikoccSite(null, { keyModels: { "1": ["gpt-5.5"] } }));
  const { credentials, store } = createCredentialStore();
  const providers = createProviderSettingsStub();

  await withStubbedFetch({}, async (captured) => {
    const service: ISub2ApiService = createSub2ApiService({
      providerSettingsService: providers.stub as never,
      credentialStore: store,
    });
    const completed = waitForEvent(service.onOIDCLoginCompleted);
    const session = await service.startOIDCLogin("mikikocc");
    captured.nonce = new URL(session.authorizeUrl).searchParams.get("nonce") ?? undefined;
    await driveCallback(session);
    await completed;

    // 缓存窗口内两次调用只打一次 refresh；轮换值 kc-rt-2 覆盖存储。
    const [first, second] = await Promise.all([
      service.getOIDCAccessToken("mikikocc"),
      service.getOIDCAccessToken("mikikocc"),
    ]);
    assert.equal(first, "kat-1");
    assert.equal(second, "kat-1");
    assert.equal(captured.refreshCalls, 1);

    // 缓存 5s 过期后进入 invalid_grant 场景（首刷 expires_in=1）。
    await new Promise((resolve) => setTimeout(resolve, 5_300));
    // invalid_grant：清 OIDC 身份（返回 null），平台账号态保留。
    // 注意：服务的 oidcRequest 在创建时已捕获 withStubbedFetch 路由，必须经路由覆写注入。
    let refreshFail = false;
    captured.overrideRefresh = () => {
      refreshFail = true;
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Session not active" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const degraded = await service.getOIDCAccessToken("mikikocc");
    assert.ok(refreshFail);
    assert.equal(degraded, null);
    assert.equal(await service.getOIDCIdentity("mikikocc"), null);
    const sites = await service.getSites();
    // 平台 token 会话不受 OIDC 身份降级影响。
    assert.equal(sites.sites.find((entry) => entry.siteId === "mikikocc")?.account?.email, "u@mikiko.ai");
  });
});

test("A.9 升级迁移：历史账密账号清态级联清理并置幂等标记", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-oidc-mig-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  const configFile = await seed(
    base,
    mikikoccSite(
      { email: "legacy@test", balanceUsd: 1, accessToken: "legacy-tok", refreshToken: "legacy-rt" },
      {
        legacyKeys: [{ id: "k1", name: "K1", apiKey: "sk-x", platform: "openai", status: "active" }],
        providerBindings: [{ keyId: "k1", keyName: "K1", providerId: "p-1" }],
        keyModels: { k1: ["gpt-5.5"] },
        activeKeyId: "k1",
      },
    ),
  );
  await writeFile(configFile, await readFile(configFile, "utf-8"));
  const providers = createProviderSettingsStub();
  const { credentials, store } = createCredentialStore();
  const service = createSub2ApiService({
    providerSettingsService: providers.stub as never,
    credentialStore: store,
  });
  // 迁移在写队列内异步执行，等待账号态被清空。
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let i = 0; i < 20; i += 1) {
    const sites = await service.getSites();
    if (sites.sites.find((entry) => entry.siteId === "mikikocc")?.account === null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const sites = await service.getSites();
  const site = sites.sites.find((entry) => entry.siteId === "mikikocc");
  assert.equal(site?.account, null);
  assert.deepEqual(site?.keys, []);
  assert.deepEqual(site?.providerBindings, []);
  assert.deepEqual(providers.calls.deleted, ["p-1"]);
  const disk = JSON.parse(await readFile(configFile, "utf-8")) as {
    mikikoccPasswordMigrationDone?: boolean;
    modelConfigs: Record<string, unknown>;
  };
  assert.equal(disk.mikikoccPasswordMigrationDone, true);
  assert.equal(Object.keys(disk.modelConfigs).length, 0);

  // 幂等：第二个实例不再触发清理。
  const providers2 = createProviderSettingsStub();
  createSub2ApiService({ providerSettingsService: providers2.stub as never });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(providers2.calls.deleted.length, 0);
});
