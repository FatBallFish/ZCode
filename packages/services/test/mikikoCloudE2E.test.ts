/**
 * Mikiko 自建云端 E2E（spec specs/mikiko-cloud/agent-endpoint-plan.md 验收场景）：
 * 真实 HTTP 服务（内存 KV/R2 的 Worker fetch handler 包 node:http）× 客户端真实实现
 * （MikokoBuiltinConfigClient、MikikoClientConfigService、ConversationShareHttpClient、
 * 设备 token 注册），验证 P1–P3 全链路在端到端语义下成立。
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestListener } from "node:http";
// 从公开入口跨包导入（AGENTS.md：跨包导入使用公开入口；review S12）。
// 内存 KV 为本文件内联实现，避免再从 mikiko-cloud/test 相对路径取测试辅助。
import worker from "@zcode/mikiko-cloud";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import {
  buildConversationShareConfirmRequest,
  sha256ConversationShareJson,
} from "../src/conversation-share/conversationShareIntegrity.js";

/** 与生产 conversationShareService 一致：声明值 = 整个 confirm 请求的规范哈希。 */
function declaredPayloadSha(confirmRequest: object): string {
  return sha256ConversationShareJson(confirmRequest);
}
import {
  invalidateAndReacquireMikikoShareDeviceToken,
  resetMikikoShareDeviceTokenCache,
  resolveMikikoShareDeviceToken,
} from "../src/conversation-share/mikikoShareDeviceToken.js";
import { fetchMikikoBuiltinRemoteRelease } from "../src/model-provider/mikikoBuiltinRemoteConfig.js";
import { createMikikoClientConfigService } from "../src/model-provider/mikikoClientConfigService.js";
import type { ApiClient } from "@zcode/shared";

const fetchApiClient: ApiClient = { request: (input, init) => fetch(input, init) };

function createMemoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string): Promise<string | unknown | null> {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async getWithMetadata(key: string) {
      const value = store.get(key);
      return { value: value === undefined ? null : value, metadata: null };
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
      const prefix = options?.prefix ?? "";
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      };
    },
  };
}

const credentialStoreMap = new Map<string, string>();
const memoryCredentialStore = {
  async load(key: string) {
    return credentialStoreMap.get(key) ?? null;
  },
  async save(key: string, value: string) {
    credentialStoreMap.set(key, value);
  },
  async delete(key: string) {
    credentialStoreMap.delete(key);
  },
};

function createFreshEnv() {
  return {
    // mock ASSETS（2026-09-28 落地页 404 报障教训）：此前 E2E env 无 ASSETS，
    // 落地页分支必 404，从没被断言过。
    ASSETS: {
      async fetch(input: URL | Request | string): Promise<Response> {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === "/share.html") {
          return new Response(null, { status: 307, headers: { location: "/share" } });
        }
        if (url.pathname === "/share") {
          return new Response("<!doctype html>mikiko-share", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    },
    MIKIKO_BUILTIN_CONFIG: createMemoryKv(),
    MIKIKO_CLIENT_CONFIG: createMemoryKv(),
    MIKIKO_SHARE: createMemoryKv(),
    SHARE_ARTIFACTS: {
      store: new Map<string, { body: ArrayBuffer; contentType?: string }>(),
      async put(
        key: string,
        value: ArrayBuffer,
        options?: { httpMetadata?: { contentType?: string } },
      ) {
        this.store.set(key, { body: value, contentType: options?.httpMetadata?.contentType });
      },
      async get(key: string) {
        const entry = this.store.get(key);
        if (!entry) return null;
        return {
          body: entry.body,
          size: entry.body.byteLength,
          httpMetadata: { contentType: entry.contentType },
        };
      },
    },
    MIKIKO_ADMIN_USERNAME: "admin",
    MIKIKO_ADMIN_PASSWORD: "e2e-password",
    MIKIKO_ADMIN_SESSION_SECRET: "e2e-session-secret",
  };
}

// node:test 的 describe 内用例默认并发执行；分享用例共享限流分钟桶会互相干扰
//（表现为用例内首次发布即 429）。每个用例重置一份干净 Worker env（KV/R2 全隔离），
// 并强制套件内串行，保证限流断言的确定性。
let env = createFreshEnv();
function resetWorkerEnv(): void {
  env = createFreshEnv();
  resetMikikoShareDeviceTokenCache();
  // 设备表已随新 env 清空，旧 token 必须同步失效，否则首个请求会带着新表不认识的
  // token 得到 401。
  credentialStoreMap.clear();
}

let server: http.Server;
let origin = "";

const requestListener: RequestListener = (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const init: RequestInit = {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
      };
      const response = await worker.fetch(new Request(url, init), env);
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(body);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
};

const ENV_KEYS = [
  "MIKIKO_BUILTIN_CONFIG_URL",
  "MIKIKO_CLIENT_CONFIG_URL",
  "MIKIKO_SHARE_API_BASE",
  "MIKIKO_SHARE_WEB_URL",
] as const;

before(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer(requestListener);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
  process.env.MIKIKO_BUILTIN_CONFIG_URL = `${origin}/api/v1/builtin-provider-config`;
  process.env.MIKIKO_CLIENT_CONFIG_URL = `${origin}/api/v1/client/configs`;
  process.env.MIKIKO_SHARE_API_BASE = `${origin}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  resetMikikoShareDeviceTokenCache();
});

for (const key of ENV_KEYS) {
  // 起服务前置的 env 在断言后统一清理：进程级测试环境不泄漏给其他用例。
  process.on("exit", () => delete process.env[key]);
}

const VALID_BUILTIN_CONFIG = {
  providerConfigRules: { templateRules: [], providerRules: [] },
  modelConfigRules: {
    modelRules: [],
    modelApiRules: [],
    providerSiteRules: [],
    templateModelRules: [],
    builtinProviderModelRules: [],
  },
};

async function adminLogin(): Promise<string> {
  const response = await fetch(`${origin}/api/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "e2e-password" }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

function baseRow(rowId: number) {
  return { rowId, turnId: "turn-1", createdAt: 1_700_000_000, createdAtSeq: 0 };
}

// 最小合法投影（与 shared conversationRowSchema 逐行对齐）：turnHeader.origin 用
// turnHeader 枚举（userInput 系），userInput.origin 用其独立枚举（realUser 系），
// assistantText 必填 state。
const SHARE_ROWS = [
  {
    ...baseRow(1),
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000,
  },
  { ...baseRow(2), kind: "userInput", text: "你好", origin: "realUser" },
  { ...baseRow(3), kind: "assistantText", text: "你好，我是 Mikiko。", state: "complete" },
];

describe("E2E：模型预置配置与功能配置", { concurrency: false }, () => {
  it("管理端发布 → 客户端单跳拉取 Release（revision 语义）", async () => {
    resetWorkerEnv();
    const cookie = await adminLogin();
    const put = await fetch(`${origin}/api/v1/admin/builtin-config`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: VALID_BUILTIN_CONFIG }),
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { revision: number }).revision, 1);

    const release = await fetchMikikoBuiltinRemoteRelease({ apiClient: fetchApiClient });
    assert.equal(release?.revision, 1);
    assert.equal(release?.config.modelConfigRules.rules().length, 0);
  });

  it("客户端功能配置服务读取自建 dynamicWorkflow 与限流（fail-open 默认 alwaysOn）", async () => {
    resetWorkerEnv();
    const service = createMikikoClientConfigService({ apiClient: fetchApiClient });
    const dynamicWorkflow = await service.getDynamicWorkflowClientConfig({ forceRefresh: true });
    assert.equal(dynamicWorkflow.mode, "alwaysOn");
    assert.equal(await service.getSharePublishRateLimit({ forceRefresh: true }), 3);
  });
});

describe("E2E：对话分享全链路（客户端真实 HTTP 实现）", { concurrency: false }, () => {
  function createShareClient(): ConversationShareHttpClient {
    return new ConversationShareHttpClient({
      apiClient: fetchApiClient,
      baseUrl: `${origin}/api/v1`,
      tokenProvider: () =>
        resolveMikikoShareDeviceToken({
          apiClient: fetchApiClient,
          credentialService: memoryCredentialStore,
        }),
    });
  }

  it("capabilities → preparation → confirm → preview → continuation", async () => {
    resetWorkerEnv();
    const client = new ConversationShareHttpClient({
      apiClient: fetchApiClient,
      baseUrl: `${origin}/api/v1`,
      tokenProvider: () =>
        resolveMikikoShareDeviceToken({
          apiClient: fetchApiClient,
          credentialService: memoryCredentialStore,
        }),
    });
    const capabilities = await client.getCapabilities();
    assert.equal(capabilities.schema_version, 1);
    assert.ok(capabilities.access_modes.includes("public_importable"));

    const confirmRequest1 = buildConversationShareConfirmRequest({
      selected_product_turn_ids: ["turn-1"],
      projection: { rows: SHARE_ROWS as never },
      artifacts: [],
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1_700_000_001,
        acknowledged_no_secret_detection: true,
      },
    });
    const preparation = await client.createPreparation({
      client_request_id: "e2e-req-1",
      title: "E2E 分享",
      schema_version: 1,
      access_mode: "public_importable",
      payload_sha256: declaredPayloadSha(confirmRequest1),
      artifact_count: 0,
    });
    assert.ok(preparation.preparation_id.length > 0);

    // 与产品发布链路同源：integrity 由 buildConversationShareConfirmRequest 按规范
    // JSON 哈希计算，preview 端会校验服务端回显一致性。
    const record = await client.confirm(preparation.preparation_id, confirmRequest1);
    assert.match(record.share_url, /^http:\/\/127\.0\.0\.1:\d+\/cn\/share\/[a-z0-9]{10}$/u);

    const preview = await client.getPreview(record.share_code);
    assert.equal(preview.rows.length, 3);
    assert.equal(preview.unsupportedRowCount, 0);
    assert.equal(preview.share.title, "E2E 分享");

    // 落地页可达（2026-09-28 线上 404 报障补）：发布产出的 share_url 必须经 Worker
    // 改写返回页面，而不是只断言 URL 格式。
    const landing = await fetch(record.share_url);
    assert.equal(landing.status, 200, `落地页 ${record.share_url} 应可访问`);
    assert.match(await landing.text(), /mikiko-share/u);

    const continuation = await client.getContinuation(record.share_code, {
      schema_version: 1,
      client_request_id: "e2e-import-1",
    });
    assert.equal(continuation.rows.length, 3);
    assert.ok(continuation.import_grant_id.length > 0);
  });

  it("限流阈值调至 1 后，第二次发布被 429 拒绝", async () => {
    resetWorkerEnv();
    const cookie = await adminLogin();
    const put = await fetch(`${origin}/api/v1/admin/client-configs`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        dynamicWorkflow: { mode: "alwaysOn" },
        share: { publishPerMinutePerIp: 1 },
      }),
    });
    assert.equal(put.status, 200);

    const client = createShareClient();
    const first = await client.createPreparation({
      client_request_id: "e2e-req-2",
      title: "限流第一次",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: "0".repeat(64),
      artifact_count: 0,
    });
    assert.ok(first.preparation_id.length > 0);

    await assert.rejects(
      client.createPreparation({
        client_request_id: "e2e-req-3",
        title: "限流第二次",
        schema_version: 1,
        access_mode: "private",
        payload_sha256: "0".repeat(64),
        artifact_count: 0,
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return /rate_limited|3002|429/u.test(message);
      },
    );

    // 还原默认阈值，避免影响同进程其他用例。
    const restore = await fetch(`${origin}/api/v1/admin/client-configs`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        dynamicWorkflow: { mode: "alwaysOn" },
        share: { publishPerMinutePerIp: 60 },
      }),
    });
    assert.equal(restore.status, 200);
  });

  it("artifact 上传与公开下载（multipart 全链路）", async () => {
    resetWorkerEnv();
    const { createHash } = await import("node:crypto");
    const content = "# 结果物\nE2E 附件内容";
    const sha = createHash("sha256").update(content).digest("hex");
    const client = createShareClient();

    const confirmRequest4 = buildConversationShareConfirmRequest({
      selected_product_turn_ids: ["turn-1"],
      projection: { rows: SHARE_ROWS.slice(0, 1) as never },
      artifacts: [
        {
          artifact_id: "e2e-art-1",
          logical_artifact_key: "result",
          producer_product_turn_id: "turn-1",
          artifact_version: 1,
          state: "current",
          ref: "zcode-artifact://share/e2e-art-1",
          artifact_type: "md",
          display_name: "result.md",
          extension: "md",
          mime_type: "text/markdown",
          size_bytes: Buffer.byteLength(content),
          sha256: sha,
        },
      ],
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1_700_000_002,
        acknowledged_no_secret_detection: true,
      },
    });
    const preparation = await client.createPreparation({
      client_request_id: "e2e-req-4",
      title: "带附件分享",
      schema_version: 1,
      access_mode: "public_readonly",
      payload_sha256: declaredPayloadSha(confirmRequest4),
      artifact_count: 1,
    });
    const upload = await client.uploadArtifact(
      preparation.preparation_id,
      {
        artifact_id: "e2e-art-1",
        logical_artifact_key: "result",
        producer_product_turn_id: "turn-1",
        artifact_version: 1,
        state: "current",
        ref: "zcode-artifact://share/e2e-art-1",
        artifact_type: "md",
        display_name: "result.md",
        extension: "md",
        mime_type: "text/markdown",
        size_bytes: Buffer.byteLength(content),
        sha256: sha,
      },
      new File([content], "result.md", { type: "text/markdown" }),
    );
    assert.equal(upload.status, "uploaded");

    const record = await client.confirm(preparation.preparation_id, confirmRequest4);
    const preview = await client.getPreview(record.share_code);
    assert.equal(preview.artifacts.length, 1);
    assert.equal(preview.artifacts[0]?.display_name, "result.md");

    const download = await fetch(preview.artifacts[0]!.url);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), content);
  });
});

describe("E2E：设备 token 生命周期", { concurrency: false }, () => {
  it("private 分享口令门：链接自带口令可直接读，缺/错口令 403（2026-09-28）", async () => {
    resetWorkerEnv();
    const client = new ConversationShareHttpClient({
      apiClient: fetchApiClient,
      baseUrl: `${origin}/api/v1`,
      tokenProvider: () =>
        resolveMikikoShareDeviceToken({
          apiClient: fetchApiClient,
          credentialService: memoryCredentialStore,
        }),
    });
    const baseRow = (rowId: number) => ({
      rowId,
      turnId: "t1",
      createdAt: 1_700_000_000,
      createdAtSeq: 0,
    });
    const rows = [
      {
        ...baseRow(1),
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 1_700_000_000,
      },
      { ...baseRow(2), kind: "userInput", text: "机密", origin: "realUser" },
    ];
    const confirmRequest = buildConversationShareConfirmRequest({
      selected_product_turn_ids: ["t1"],
      projection: { rows: rows as never },
      artifacts: [],
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1_700_000_003,
        acknowledged_no_secret_detection: true,
      },
    });
    const preparation = await client.createPreparation({
      client_request_id: "e2e-pwd-1",
      title: "口令分享",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: declaredPayloadSha(confirmRequest),
      artifact_count: 0,
    });
    const record = await client.confirm(preparation.preparation_id, confirmRequest);
    // share_url 自动携带 ?pwd=。
    assert.match(record.share_url, /\?pwd=[a-z2-9]{8}$/u);
    const pwd = new URL(record.share_url).searchParams.get("pwd")!;

    // 落地页带口令直接可开；preview API 同步校验。
    const landing = await fetch(record.share_url);
    assert.equal(landing.status, 200);
    const missing = await fetch(`${origin}/api/v1/shares/${record.share_code}/preview`);
    assert.equal(missing.status, 403);
    assert.equal(((await missing.json()) as { msg: string }).msg, "password_required");
    const wrong = await fetch(`${origin}/api/v1/shares/${record.share_code}/preview?pwd=badbad22`);
    assert.equal(wrong.status, 403);
    assert.equal(((await wrong.json()) as { msg: string }).msg, "password_mismatch");
    const ok = await fetch(`${origin}/api/v1/shares/${record.share_code}/preview?pwd=${pwd}`);
    assert.equal(ok.status, 200);
  });

  it("token 被外部重注册顶掉后，3201 自愈钩子重注册并恢复（2026-09-28 修复）", async () => {
    resetWorkerEnv();
    const home = await mkdtemp(join(tmpdir(), "mikiko-e2e-heal-"));
    const store = new Map<string, string>();
    const credentials = {
      async load(key: string) {
        return store.get(key) ?? null;
      },
      async save(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    };
    const options = { apiClient: fetchApiClient, credentialService: credentials, homeDir: home };
    const firstToken = await resolveMikikoShareDeviceToken(options);
    assert.ok(firstToken);

    // 模拟外部进程以同一 deviceMid 覆盖式重注册（历史服务端行为）：直接改写设备记录，
    // 把本进程的 secret 从列表里剔除，仅保留一个未知 secret。
    const deviceHash = firstToken.slice(0, firstToken.indexOf("."));
    const otherSecretHash = await import("node:crypto").then((c) =>
      c.createHash("sha256").update("other").digest("hex"),
    );
    await env.MIKIKO_SHARE.put(
      `device:${deviceHash}`,
      JSON.stringify({ secretHashes: [otherSecretHash] }),
    );

    // 客户端旧 token 已失效：带自愈钩子的 http client 应自动重注册并恢复。
    const client = new ConversationShareHttpClient({
      apiClient: fetchApiClient,
      baseUrl: `${origin}/api/v1`,
      tokenProvider: () => resolveMikikoShareDeviceToken(options),
      reacquireToken: () => invalidateAndReacquireMikikoShareDeviceToken(options),
    });
    const capabilities = await client.getCapabilities();
    assert.equal(capabilities.schema_version, 1);
    const healedToken = await resolveMikikoShareDeviceToken(options);
    assert.ok(healedToken && healedToken !== firstToken);
  });

  it("token 注册后持久化复用，设备标识不出网（注册请求体仅含 hash）", async () => {
    const home = await mkdtemp(join(tmpdir(), "mikiko-e2e-home-"));
    // 独立凭据 store：避免命中其他用例已注册的 token，确保本用例真实发起注册请求。
    const isolatedStore = new Map<string, string>();
    const isolatedCredentials = {
      async load(key: string) {
        return isolatedStore.get(key) ?? null;
      },
      async save(key: string, value: string) {
        isolatedStore.set(key, value);
      },
      async delete(key: string) {
        isolatedStore.delete(key);
      },
    };
    let registeredDeviceId = "";
    const spyApiClient: ApiClient = {
      request: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/shares/device/register")) {
          registeredDeviceId = (JSON.parse(String(init?.body)) as { deviceId: string }).deviceId;
        }
        return fetch(input, init);
      },
    };
    const token = await resolveMikikoShareDeviceToken({
      apiClient: spyApiClient,
      credentialService: isolatedCredentials,
      homeDir: home,
    });
    assert.ok(token);
    assert.match(registeredDeviceId, /^[0-9a-f]{64}$/u);
    // 原始 deviceMid（UUID 形态）不得出现在注册载荷里。
    assert.ok(!registeredDeviceId.includes("-"));
    resetMikikoShareDeviceTokenCache();
    const again = await resolveMikikoShareDeviceToken({
      apiClient: fetchApiClient,
      credentialService: isolatedCredentials,
      homeDir: home,
    });
    assert.equal(again, token);
  });
});
