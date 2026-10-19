import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSub2ApiService } from "../src/sub2api/sub2apiService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * 2026-10-20 两项修复的回归：
 * 1. refreshSiteToken 成功后必须落盘（sub2api /auth/refresh 轮换 refresh token，
 *    旧值立即作废；此前只变异内存，重启后会被静默登出）。
 * 2. 登录后自动同步供应商失败不再静默：返回 syncError 并延迟 5s 经写队列重试一次
 *    （首启 provider 运行时未 ready 的窗口即被覆盖）。
 */

function envelope(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, message: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(status: number): Response {
  return new Response(JSON.stringify({ code: status, message: "unauthorized" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function seedConfig(base: string, site: Record<string, unknown>): Promise<string> {
  const configFile = join(base, ".mikiko", "v2", "sub2api.json");
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({ version: 2, sites: [site], modelConfigs: {} }),
  );
  return configFile;
}

const mikikoccSite = (account: Record<string, unknown> | null) => ({
  id: "mikikocc",
  kind: "mikikocc",
  panelBaseUrl: "https://mikiko.cc",
  gatewayBaseUrl: "https://api.mikiko.cc",
  siteName: "MikikoCC",
  account,
});

test("401 触发 refresh 后新 token pair 落盘（轮换不丢失）", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-persist-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  const configFile = await seedConfig(base, mikikoccSite({
    email: "u@test",
    balanceUsd: 2,
    accessToken: "tok-expired",
    refreshToken: "rt-old",
  }));

  let meCalls = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/me")) {
      meCalls += 1;
      // 余额保持不变：确保落盘只能来自 refreshSiteToken 的显式 persistSilently，
      // 而不是 getAccountDetail 的余额变更检测路径。
      return meCalls === 1
        ? errorEnvelope(401)
        : envelope({ user: { email: "u@test", balance: 2 } });
    }
    if (url.endsWith("/api/v1/auth/refresh")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body.refresh_token, "rt-old");
      return envelope({ access_token: "tok-new", refresh_token: "rt-new", expires_in: 3600 });
    }
    return envelope({});
  }) as typeof fetch;

  const service = createSub2ApiService({ providerSettingsService: {} as never });
  const detail = await service.getAccountDetail("mikikocc");

  assert.equal(detail.account.balanceUsd, 2);
  const disk = JSON.parse(await readFile(configFile, "utf-8")) as {
    sites: Array<{ account: { accessToken?: string; refreshToken?: string } | null }>;
  };
  const stored = disk.sites[0]?.account;
  assert.equal(stored?.accessToken, "tok-new");
  assert.equal(stored?.refreshToken, "rt-new");
});

test("登录后同步失败：返回 syncError 且 5s 后经写队列重试一次", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-sync-retry-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  // keyModels 预置模型清单：无模型的密钥在 syncProviders 中不产生投影动作，
  // 预置后才会走到 createPersonalProvider（可观测点）。
  await seedConfig(base, { ...mikikoccSite(null), keyModels: { "1": ["gpt-5.5"] } });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/login")) {
      return envelope({
        access_token: "tok",
        refresh_token: "rt",
        user: { email: "u@test", balance: 1 },
      });
    }
    if (url.endsWith("/api/v1/groups/available")) {
      return envelope([]);
    }
    if (url.endsWith("/api/v1/keys?page=1&page_size=200")) {
      // 给一枚密钥：零密钥时 syncProviders 无可投影对象会直接成功，
      // 无法覆盖「同步失败」路径。
      return envelope({ items: [{ id: "1", key: "sk-1", name: "K1", status: "active" }] });
    }
    return envelope({});
  }) as typeof fetch;

  // createPersonalProvider 抛错 → syncProviders 对该密钥的投影被跳过
  // （per-key 降级语义），表现为 bindings < keys 的「部分未同步」（模拟首启
  // provider 运行时未 ready 的客户场景：登录成功但模型列表为空）。
  let createCalls = 0;
  const providerSettingsStub = {
    createPersonalProvider: async () => {
      createCalls += 1;
      throw new Error("provider runtime not ready");
    },
  };

  test.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    test.mock.timers.reset();
  });

  const service = createSub2ApiService({
    providerSettingsService: providerSettingsStub as never,
  });
  const result = await service.login({
    siteId: "mikikocc",
    email: "u@test",
    password: "pw",
  });

  assert.equal(result.state.account?.email, "u@test");
  assert.equal(result.syncedKeyCount, 1);
  // 部分跳过路径：syncError 携带「已同步/总数」信号。
  assert.match(result.syncError ?? "", /0\/1/);
  assert.equal(createCalls, 1);

  // 5s 定时器触发延迟重试：经序列化代理再次进入 syncProviders（create 第二次被调）。
  test.mock.timers.tick(5_000);
  // 重试链路含真实异步文件 IO（loadConfig 重读盘），需要多个事件循环回合收敛。
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(createCalls, 2);
});
