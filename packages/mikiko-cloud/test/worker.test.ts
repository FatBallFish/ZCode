import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/worker.ts";
import { createMemoryKv, createMemoryR2 } from "./helpers.ts";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "correct-horse";
const ADMIN_SESSION_SECRET = "test-session-secret-32-bytes-xxxxxxxx";

/** mock ASSETS：模拟 html_handling（/share.html → 307 /share；/share → 200）。 */
function createMockAssets() {
  const fetched: string[] = [];
  const assets = {
    fetched,
    async fetch(input: URL | Request | string): Promise<Response> {
      const url = input instanceof URL ? input : new URL(String(input));
      fetched.push(url.pathname);
      if (url.pathname === "/share.html") {
        return new Response(null, { status: 307, headers: { location: "/share" } });
      }
      if (url.pathname === "/share") {
        return new Response("<!doctype html>share-page", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  };
  return assets;
}

function createEnv() {
  return {
    ASSETS: createMockAssets() as unknown as Fetcher,
    MIKIKO_BUILTIN_CONFIG: createMemoryKv(),
    MIKIKO_CLIENT_CONFIG: createMemoryKv(),
    MIKIKO_SHARE: createMemoryKv(),
    SHARE_ARTIFACTS: createMemoryR2(),
    MIKIKO_ADMIN_USERNAME: ADMIN_USERNAME,
    MIKIKO_ADMIN_PASSWORD: ADMIN_PASSWORD,
    MIKIKO_ADMIN_SESSION_SECRET: ADMIN_SESSION_SECRET,
  };
}

function call(
  env: ReturnType<typeof createEnv>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://agent.mikiko.ai${path}`, init),
    env,
  ) as Promise<Response>;
}

async function login(env: ReturnType<typeof createEnv>): Promise<string> {
  const response = await call(env, "/api/v1/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie?.includes("mikiko_admin_session="), "登录应下发 session cookie");
  return setCookie!.split(";")[0]!;
}

const VALID_CONFIG = {
  providerConfigRules: { templateRules: [], providerRules: [] },
  modelConfigRules: {
    modelRules: [],
    modelApiRules: [],
    providerSiteRules: [],
    templateModelRules: [],
    builtinProviderModelRules: [],
  },
};

describe("公开端点", () => {
  it("分享落地页 /cn/share/{code} 经 Worker 改写并跟随 html_handling 重定向返回页面", async () => {
    const env = createEnv();
    const zh = await call(env, "/cn/share/abc123");
    assert.equal(zh.status, 200);
    assert.match(await zh.text(), /share-page/u);
    const en = await call(env, "/share/abc123");
    assert.equal(en.status, 200);
    // 改写顺序：先 /share.html（307）→ /share（200）。
    assert.deepEqual((env.ASSETS as unknown as { fetched: string[] }).fetched.slice(-2), [
      "/share.html",
      "/share",
    ]);
  });

  it("缺少 ASSETS binding 时落地页明确 404（部署配置回归守卫）", async () => {
    const env = createEnv();
    delete (env as { ASSETS?: unknown }).ASSETS;
    const response = await call(env, "/cn/share/abc123");
    assert.equal(response.status, 404);
  });

  it("GET /healthz 返回服务版本", async () => {
    const response = await call(createEnv(), "/healthz");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; version: string };
    assert.equal(body.ok, true);
  });

  it("未种子化时 builtin-provider-config 返回 404 not_initialized", async () => {
    const response = await call(createEnv(), "/api/v1/builtin-provider-config");
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "not_initialized");
  });

  it("client/configs 无 KV 数据时 fail-open 返回默认（dynamicWorkflow alwaysOn + 限流 3）", async () => {
    const response = await call(createEnv(), "/api/v1/client/configs");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      code: number;
      data: {
        configs: { dynamicWorkflow: { mode: string }; share: { publishPerMinutePerIp: number } };
      };
    };
    assert.equal(body.code, 0);
    assert.equal(body.data.configs.dynamicWorkflow.mode, "alwaysOn");
    assert.equal(body.data.configs.share.publishPerMinutePerIp, 3);
  });
});

describe("管理端点鉴权", () => {
  it("错误密码登录返回 401", async () => {
    const response = await call(createEnv(), "/api/v1/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: "wrong" }),
    });
    assert.equal(response.status, 401);
  });

  it("无 session cookie 访问管理 API 返回 401", async () => {
    const response = await call(createEnv(), "/api/v1/admin/builtin-config");
    assert.equal(response.status, 401);
  });

  it("伪造 session token 被拒绝", async () => {
    const env = createEnv();
    const response = await call(env, "/api/v1/admin/builtin-config", {
      headers: { cookie: "mikiko_admin_session=forge.signature" },
    });
    assert.equal(response.status, 401);
  });
});

describe("builtin-config 管理", () => {
  it("发布合法配置 → 公开端点立即可读，revision 自增并留档", async () => {
    const env = createEnv();
    const cookie = await login(env);

    const put = await call(env, "/api/v1/admin/builtin-config", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: VALID_CONFIG }),
    });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { revision: number }).revision, 1);

    const publicGet = await call(env, "/api/v1/builtin-provider-config");
    assert.equal(publicGet.status, 200);
    const release = (await publicGet.json()) as {
      schemaVersion: number;
      revision: number;
      config: typeof VALID_CONFIG;
    };
    assert.equal(release.schemaVersion, 1);
    assert.equal(release.revision, 1);
    assert.deepEqual(release.config, VALID_CONFIG);

    const history = await call(env, "/api/v1/admin/builtin-config/history", {
      headers: { cookie },
    });
    const historyBody = (await history.json()) as {
      currentRevision: number;
      entries: Array<{ revision: number }>;
    };
    assert.equal(historyBody.currentRevision, 1);
    assert.deepEqual(
      historyBody.entries.map((entry) => entry.revision),
      [1],
    );
  });

  it("多余键 / 含退役 provider / 非对象配置均被拒绝且不落盘", async () => {
    const env = createEnv();
    const cookie = await login(env);
    const cases = [
      { ...VALID_CONFIG, extra: {} },
      {
        providerConfigRules: { templateRules: [], providerRules: [{ id: "builtin:zapi" }] },
        modelConfigRules: VALID_CONFIG.modelConfigRules,
      },
      { providerConfigRules: [], modelConfigRules: VALID_CONFIG.modelConfigRules },
    ];
    for (const config of cases) {
      const response = await call(env, "/api/v1/admin/builtin-config", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
      assert.equal(response.status, 400, `配置 ${JSON.stringify(config).slice(0, 60)} 应被拒绝`);
    }
    const publicGet = await call(env, "/api/v1/builtin-provider-config");
    assert.equal(publicGet.status, 404, "发布失败不得写入 current");
  });

  it("restoreRevision 从历史留档恢复且 revision 保持单调", async () => {
    const env = createEnv();
    const cookie = await login(env);
    for (let index = 0; index < 2; index += 1) {
      const response = await call(env, "/api/v1/admin/builtin-config", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ config: VALID_CONFIG }),
      });
      assert.equal(response.status, 200);
    }
    const restore = await call(env, "/api/v1/admin/builtin-config", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ restoreRevision: 1 }),
    });
    assert.equal(restore.status, 200);
    assert.equal(((await restore.json()) as { revision: number }).revision, 3);

    const missing = await call(env, "/api/v1/admin/builtin-config", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ restoreRevision: 99 }),
    });
    assert.equal(missing.status, 404);
  });
});

describe("client-configs 管理", () => {
  it("PUT 合法配置后公开端点返回新值", async () => {
    const env = createEnv();
    const cookie = await login(env);
    const put = await call(env, "/api/v1/admin/client-configs", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        dynamicWorkflow: { mode: "onDemand" },
        share: { publishPerMinutePerIp: 5 },
      }),
    });
    assert.equal(put.status, 200);

    const publicGet = await call(env, "/api/v1/client/configs");
    const body = (await publicGet.json()) as {
      data: {
        configs: { dynamicWorkflow: { mode: string }; share: { publishPerMinutePerIp: number } };
      };
    };
    assert.equal(body.data.configs.dynamicWorkflow.mode, "onDemand");
    assert.equal(body.data.configs.share.publishPerMinutePerIp, 5);
  });

  it("非法 mode / 超范围限流被拒绝", async () => {
    const env = createEnv();
    const cookie = await login(env);
    for (const payload of [
      { dynamicWorkflow: { mode: "bogus" } },
      { share: { publishPerMinutePerIp: 0 } },
      { share: { publishPerMinutePerIp: 999 } },
    ]) {
      const response = await call(env, "/api/v1/admin/client-configs", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
    }
  });
});
