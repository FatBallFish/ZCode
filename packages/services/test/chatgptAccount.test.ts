import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import type { ChatGPTAccountRecord, ChatGPTAccountView } from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { createChatGPTAccountRepository } from "../src/chatgpt/chatgptAccountRepository.js";
import { createChatGPTAccountRuntime } from "../src/chatgpt/chatgptAccountRuntime.js";
import { createChatGPTAccountService } from "../src/chatgpt/chatgptAccountService.js";
import { createChatGPTBackendClient } from "../src/chatgpt/chatgptBackendClient.js";
import { createChatGPTIdentityResolver } from "../src/chatgpt/chatgptIdentity.js";
import { AccountRequestCredentialUnavailableError } from "../src/model-provider/accountProviderRequestAuthService.js";

/** 进程内凭据服务（真实栈走加密文件；这里只验证仓储行为）。 */
function createMemoryCredentialService(): ICredentialService & { dump(): string | null } {
  let store: string | null = null;
  return {
    async load() {
      return store;
    },
    async save(key, value) {
      assert.equal(key, "chatgpt-accounts");
      store = value;
    },
    async delete() {
      store = null;
    },
    dump: () => store,
  };
}

function makeAccount(overrides: Partial<ChatGPTAccountRecord> = {}): ChatGPTAccountRecord {
  const nowIso = new Date("2026-10-11T00:00:00Z").toISOString();
  return {
    accountId: "acc-1",
    email: "user@example.com",
    createdAt: nowIso,
    updatedAt: nowIso,
    credentials: {
      accessToken: "at-old",
      refreshToken: "rt-old",
      lastRefreshAt: nowIso,
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    },
    profile: { isFedramp: false },
    status: { state: "active", updatedAt: 0 },
    ...overrides,
  };
}

function createIdentityStub() {
  return createChatGPTIdentityResolver({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    settingService: {
      async get() {
        return {} as never;
      },
    } as never,
    mikikoClientConfigService: {
      async getCodexClientVersion() {
        return null;
      },
    },
    appVersion: "1.0.0",
  });
}

function oauthResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("仓储：upsert/update/delete 往返与 createdAt 排序", async () => {
  const credentialService = createMemoryCredentialService();
  const repository = createChatGPTAccountRepository({ credentialService });
  await repository.upsert(makeAccount());
  await repository.upsert(makeAccount({ accountId: "acc-0", createdAt: "2026-10-10T00:00:00Z" }));
  let list = await repository.list();
  assert.deepEqual(
    list.map((entry) => entry.accountId),
    ["acc-0", "acc-1"],
    "按 createdAt 升序",
  );
  await repository.update("acc-1", (record) => ({
    ...record,
    email: "changed@example.com",
  }));
  assert.equal((await repository.get("acc-1"))?.email, "changed@example.com");
  assert.equal(await repository.delete("acc-1"), true);
  list = await repository.list();
  assert.equal(list.length, 1);
  assert.ok(credentialService.dump(), "落盘经过 credentialService 单键");
});

test("runtime 刷新：到期窗口触发、RT 非空覆盖、id_token/claims 更新", async () => {
  const credentialService = createMemoryCredentialService();
  const repository = createChatGPTAccountRepository({ credentialService });
  const emitter = new Emitter<ChatGPTAccountView[]>();
  let refreshed = false;
  const runtime = createChatGPTAccountRuntime({
    repository,
    identity: createIdentityStub(),
    accountsChangedEmitter: emitter,
    request: (async () => {
      refreshed = true;
      // 轮换 refresh_token；access_token 不带 exp（走 8 天兜底路径）。
      return oauthResponse({
        access_token: "at-new",
        refresh_token: "rt-new",
      });
    }) as typeof fetch,
  });
  await repository.upsert(
    makeAccount({
      credentials: {
        accessToken: "at-old",
        refreshToken: "rt-old",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastRefreshAt: new Date().toISOString(),
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      },
    }),
  );
  const auth = await runtime.resolveRequestAuth("acc-1");
  assert.equal(refreshed, true, "exp - now ≤ 5min 触发惰性刷新");
  assert.equal(auth.apiKey, "at-new");
  const record = await repository.get("acc-1");
  assert.equal(record?.credentials.refreshToken, "rt-new", "非空 RT 覆盖");
  // 身份头包含 account-id 与 service tier 私有载体。
  assert.equal(auth.headers["chatgpt-account-id"], "acc-1");
  assert.equal(auth.headers["x-mikiko-chatgpt-service-tier"], "auto");
});

test("runtime 刷新：Permanent 失败写缓存并短路后续刷新", async () => {
  const credentialService = createMemoryCredentialService();
  const repository = createChatGPTAccountRepository({ credentialService });
  const emitter = new Emitter<ChatGPTAccountView[]>();
  let refreshCalls = 0;
  const runtime = createChatGPTAccountRuntime({
    repository,
    identity: createIdentityStub(),
    accountsChangedEmitter: emitter,
    request: (async () => {
      refreshCalls += 1;
      return oauthResponse({ error: "invalid_grant", error_description: "bad" }, 400);
    }) as typeof fetch,
  });
  await repository.upsert(
    makeAccount({
      credentials: {
        ...makeAccount().credentials,
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await assert.rejects(
    () => runtime.resolveRequestAuth("acc-1"),
    (error: unknown) => error instanceof Error,
  );
  assert.equal(refreshCalls, 1);
  let record = await repository.get("acc-1");
  assert.equal(record?.status.state, "auth-error");
  assert.equal(record?.permanentRefreshFailure?.reason, "invalid_grant");
  // Permanent 缓存短路：后续请求直接 Unavailable，不再打刷新接口。
  await assert.rejects(
    () => runtime.resolveRequestAuth("acc-1"),
    (error: unknown) => error instanceof AccountRequestCredentialUnavailableError,
  );
  assert.equal(refreshCalls, 1, "同凭证快照不重复刷新");
  // 信封摘除。
  await repository.update("acc-1", (current) => ({
    ...current,
    models: { slugs: ["gpt-5.4"], updatedAt: new Date().toISOString() },
  }));
  const envelope = await runtime.buildEnvelope();
  assert.equal(envelope.providers["account:chatgpt:acc-1"], undefined);
});

test("runtime outcome：401 强刷自愈 / 403 置 auth-error / 429 合并 usage", async () => {
  const credentialService = createMemoryCredentialService();
  const repository = createChatGPTAccountRepository({ credentialService });
  const emitter = new Emitter<ChatGPTAccountView[]>();
  let refreshStatus = 200;
  const runtime = createChatGPTAccountRuntime({
    repository,
    identity: createIdentityStub(),
    accountsChangedEmitter: emitter,
    request: (async () =>
      refreshStatus === 200
        ? oauthResponse({ access_token: "at-healed", refresh_token: "rt-healed" })
        : oauthResponse({ error: "invalid_grant" }, 400)) as typeof fetch,
  });
  await repository.upsert(makeAccount());

  // 401：强制刷新成功 → 保持 active（自愈）。
  await runtime.applyRequestOutcome({
    providerId: "account:chatgpt:acc-1",
    kind: "auth-error",
    status: 401,
  });
  assert.equal((await repository.get("acc-1"))?.status.state, "active");
  assert.equal((await repository.get("acc-1"))?.credentials.accessToken, "at-healed");

  // 403：结构化错误直接 auth-error。
  await runtime.applyRequestOutcome({
    providerId: "account:chatgpt:acc-1",
    kind: "auth-error",
    status: 403,
    errorCode: "misalignment_policy_violation",
  });
  let record = await repository.get("acc-1");
  assert.equal(record?.status.state, "auth-error");
  assert.equal(record?.status.reason, "misalignment_policy_violation");

  // 429：usage 快照合并（重置为 active 以便验证）。
  await repository.update("acc-1", (current) => ({
    ...current,
    status: { state: "active", updatedAt: Date.now() },
    permanentRefreshFailure: undefined,
  }));
  await runtime.applyRequestOutcome({
    providerId: "account:chatgpt:acc-1",
    kind: "usage",
    usageLimit: { planType: "plus", resetsAt: "2030-01-01T00:00:00Z", limitWindowMinutes: 300 },
    rateLimitHeaders: { primary: { usedPercent: 100, windowMinutes: 5 } },
  });
  record = await repository.get("acc-1");
  assert.equal(record?.usage?.window5h?.usedPercent, 100);
  assert.equal(record?.usage?.limitReached, true);
  assert.equal(record?.status.state, "active", "429 不改变账号状态");
});

test("runtime 信封：active 账号投影 provider，无模型不发布", async () => {
  const credentialService = createMemoryCredentialService();
  const repository = createChatGPTAccountRepository({ credentialService });
  const runtime = createChatGPTAccountRuntime({
    repository,
    identity: createIdentityStub(),
    accountsChangedEmitter: new Emitter<ChatGPTAccountView[]>(),
  });
  await repository.upsert(
    makeAccount({ models: { slugs: ["gpt-5.4", "gpt-5.6"], updatedAt: new Date().toISOString() } }),
  );
  await repository.upsert(makeAccount({ accountId: "acc-no-models" }));
  const envelope = await runtime.buildEnvelope();
  const provider = envelope.providers["account:chatgpt:acc-1"] as {
    group: string;
    access: { type: string; accountId: string; entitled: boolean };
    api: { type: string; baseUrl: string };
    builtinModelIds: string[];
  };
  assert.ok(provider);
  assert.equal(provider.group, "chatgpt-family");
  assert.deepEqual(provider.access, {
    type: "chatgpt-account",
    accountId: "acc-1",
    entitled: true,
  });
  assert.equal(provider.api.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.deepEqual(provider.builtinModelIds, ["gpt-5.4", "gpt-5.6"]);
  assert.deepEqual(envelope.states["account:chatgpt:acc-1"], {
    availability: "available",
    entitled: true,
    current: true,
  });
  assert.equal(envelope.providers["account:chatgpt:acc-no-models"], undefined);
});

test("sub2api 导入：建号/补全/重复导入 updated（backend client 全 mock）", async () => {
  const credentialService = createMemoryCredentialService();
  const repository = createChatGPTAccountRepository({ credentialService });
  const emitter = new Emitter<ChatGPTAccountView[]>();
  const runtime = createChatGPTAccountRuntime({
    repository,
    identity: createIdentityStub(),
    accountsChangedEmitter: emitter,
  });
  const backendClient = createChatGPTBackendClient({
    request: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/wham/accounts/check")) {
        return oauthResponse({
          accounts: {
            "org-1": {
              account: {
                account_id: "acc-import",
                plan_type: "pro",
                name: "小明",
                is_default: true,
              },
            },
          },
        });
      }
      if (url.includes("/wham/usage")) {
        return oauthResponse({
          rate_limit: {
            primary_window: { used_percent: 42, limit_window_seconds: 300 },
            secondary_window: { used_percent: 7, limit_window_seconds: 604800 },
          },
          credits: { has_credits: false, unlimited: false },
        });
      }
      if (url.includes("/wham/rate-limit-reset-credits")) {
        return oauthResponse({
          available_count: 2,
          credits: [{ id: "c1", expires_at: "2026-11-01T00:00:00Z" }],
        });
      }
      if (url.includes("/codex/models")) {
        return new Response(
          JSON.stringify({
            models: [
              { slug: "gpt-5.4", visibility: "list" },
              { slug: "gpt-internal", visibility: "hide" },
            ],
          }),
          {
            status: 200,
            headers: { etag: '"v1"' },
          },
        );
      }
      if (url.includes("/subscriptions")) {
        return oauthResponse({ active_until: "2026-10-18T16:00:24Z" });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch,
  });
  const service = createChatGPTAccountService({
    repository,
    backendClient,
    identity: createIdentityStub(),
    runtime,
    accountsChangedEmitter: emitter,
    readFile: async () =>
      JSON.stringify({
        accounts: [
          {
            platform: "openai",
            type: "oauth",
            credentials: {
              access_token: "at-import",
              refresh_token: "rt-import",
              chatgpt_account_id: "acc-import",
              email: "import@example.com",
              client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
              plan_type: "pro",
            },
          },
        ],
      }),
  });
  const first = await service.importSub2ApiAccounts("/fake/sub2api.json");
  assert.equal(first.skipped.length, 0);
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0]?.state, "created");
  const record = await repository.get("acc-import");
  assert.ok(record);
  assert.equal(record.displayName, "小明");
  assert.equal(record.profile.planExpiresAt, "2026-10-18T16:00:24.000Z");
  assert.equal(record.usage?.window5h?.usedPercent, 42);
  assert.equal(record.resetCredits?.availableCount, 2);
  assert.deepEqual(record.models?.slugs, ["gpt-5.4"], "visibility=hide 过滤");
  assert.equal(record.models?.etag, '"v1"');
  assert.equal(record.credentials.refreshToken, "rt-import", "导入凭证不经过额外刷新");

  const second = await service.importSub2ApiAccounts("/fake/sub2api.json");
  assert.equal(second.imported[0]?.state, "updated");
});
