import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSub2ApiService } from "../src/sub2api/sub2apiService.js";
import { setDataBaseDir } from "../src/paths.js";

const realFetch = globalThis.fetch;

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: "success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubProviderSettings() {
  return {
    getView: async () => ({ providers: [] }),
    createPersonalProvider: async () => ({ providerId: "p-stub" }),
    savePersonalProviderOverlay: async () => undefined,
    addPersonalModel: async () => undefined,
    deletePersonalProvider: async () => undefined,
  };
}

test("在途 listKeys 写回不得冲掉并发 addSite 的占位站点", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-race-"));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  await writeFile(
    join(base, ".mikiko", "v2", "sub2api.json"),
    JSON.stringify({
      version: 2,
      sites: [
        {
          id: "site-logged-in",
          kind: "sub2api",
          panelBaseUrl: "https://panel.test",
          siteName: "Panel",
          account: { email: "u@test", balanceUsd: 1, accessToken: "tok" },
          legacyKeys: [],
          providerBindings: [],
        },
      ],
      modelConfigs: {},
    }),
  );

  // /api/v1/keys 挂在手动闸门上：把 listKeys 的网络阶段握在测试手里，
  // 复现「余额/密钥后台刷新在途时用户添加站点」的真实交错。
  let releaseKeys: (() => void) | undefined;
  const keysGate = new Promise<void>((resolve) => {
    releaseKeys = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://panel.test/api/v1/keys")) {
      await keysGate;
      return envelope({ items: [] });
    }
    if (url.startsWith("https://panel.test/api/v1/groups/available")) {
      return envelope([{ id: 1, name: "default", platform: "openai" }]);
    }
    if (url.startsWith("https://panel.test/api/v1/auth/refresh")) {
      return envelope({ access_token: "tok", refresh_token: "tok" });
    }
    if (url.startsWith("https://bind.test/api/v1/settings/public")) {
      return envelope({ site_name: "Bind", api_base_url: "https://gw.test/v1" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const service = createSub2ApiService({
    providerSettingsService: stubProviderSettings() as never,
  });

  const listPromise = service.listKeys("site-logged-in");
  // 让 listKeys 先走到被闸门挡住的 keys 请求，确保它已捕获写盘前的旧配置快照。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const addPromise = service.addSite("about:blank");
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseKeys!();
  await Promise.all([listPromise, addPromise]);

  // 断言一：占位站点必须仍然存在（修复前：listKeys 的旧快照写回会把它抹掉）。
  const sites = await service.getSites();
  const placeholder = sites.sites.find((site) => site.pendingBind === true);
  assert.ok(placeholder, "占位站点被并发写回冲掉：addSite 结果丢失");

  // 断言二：绑定地址必须成功（修复前：findSite 找不到占位站点 → 抛「站点不存在」，
  // 即用户实测遇到的「添加供应商 → 输入站点地址 → 站点不存在」）。
  const bound = await service.bindSiteAddress(placeholder.siteId, "https://bind.test");
  assert.equal(bound.pendingBind, false);
  assert.equal(bound.panelBaseUrl, "https://bind.test");
  assert.equal(bound.siteName, "Bind");
});

test("在途 listKeys 写回不得复活已删除站点", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-race-"));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  await writeFile(
    join(base, ".mikiko", "v2", "sub2api.json"),
    JSON.stringify({
      version: 2,
      sites: [
        {
          id: "site-victim",
          kind: "sub2api",
          panelBaseUrl: "https://panel.test",
          siteName: "Panel",
          account: { email: "u@test", balanceUsd: 1, accessToken: "tok" },
          legacyKeys: [],
          providerBindings: [],
        },
      ],
      modelConfigs: {},
    }),
  );

  let releaseKeys: (() => void) | undefined;
  const keysGate = new Promise<void>((resolve) => {
    releaseKeys = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://panel.test/api/v1/keys")) {
      await keysGate;
      return envelope({ items: [] });
    }
    if (url.startsWith("https://panel.test/api/v1/groups/available")) {
      return envelope([]);
    }
    if (url.startsWith("https://panel.test/api/v1/auth/refresh")) {
      return envelope({ access_token: "tok", refresh_token: "tok" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const service = createSub2ApiService({
    providerSettingsService: stubProviderSettings() as never,
  });

  const listPromise = service.listKeys("site-victim");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // listKeys 挂在 keys 闸门上（已捕获含 site-victim 的旧快照）时并发删除站点；
  // 随后放行 listKeys——修复前它的旧快照写回会把已删站点复活。
  const removePromise = service.removeSite("site-victim");
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseKeys!();
  await Promise.all([listPromise, removePromise]);

  const sites = await service.getSites();
  assert.equal(
    sites.sites.some((site) => site.siteId === "site-victim"),
    false,
    "已删除站点被在途写回复活：removeSite 结果丢失",
  );
});
