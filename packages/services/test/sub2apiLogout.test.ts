import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import test from "node:test";

import { createSub2ApiService } from "../src/sub2api/sub2apiService.js";
import { setDataBaseDir } from "../src/paths.js";

/** logout 级联清理（2026-09-28 语义修订）：密钥供应商删除、品牌兜底清扫、
 * 绑定/模型清单/覆盖清空、站点记录保留。 */
test("logout 级联删除供应商与模型配置并保留站点记录", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-logout-"));
  t.after(async () => {
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
          id: "mikikocc",
          kind: "mikikocc",
          panelBaseUrl: "https://mikiko.cc",
          gatewayBaseUrl: "https://api.mikiko.cc",
          siteName: "MikikoCC",
          account: { email: "u@test", balanceUsd: 1, accessToken: "tok" },
          legacyKeys: [
            { id: "k1", name: "K1", apiKey: "sk-x", platform: "openai", status: "active" },
          ],
          providerBindings: [{ keyId: "k1", keyName: "K1", providerId: "p-1" }],
          keyModels: { k1: ["gpt-5.5"] },
          activeKeyId: "k1",
        },
      ],
      modelConfigs: {
        "mikikocc:k1:gpt-5.5": { enabled: true },
        "other-site:k9:m": { enabled: true },
      },
    }),
  );

  const deletedProviderIds: string[] = [];
  // providers 可变：deletePersonalProvider 后 getView 反映删除（与真实 registry 一致），
  // 否则品牌兜底清扫会重复删除 bindings 已删的供应商。
  const providers = [
    { providerId: "p-1", providerName: "MikikoCC · K1" },
    { providerId: "p-ghost", providerName: "MikikoCC · 旧密钥" },
    { providerId: "p-other", providerName: "Other · x" },
  ];
  const providerSettingsStub = {
    getView: async () => ({
      revision: 1,
      providerTemplates: [],
      providerOrder: [],
      providers: providers.filter((provider) => !deletedProviderIds.includes(provider.providerId)),
    }),
    deletePersonalProvider: async (providerId: string) => {
      deletedProviderIds.push(providerId);
    },
  };
  const service = createSub2ApiService({
    providerSettingsService: providerSettingsStub as never,
  });

  const state = await service.logout("mikikocc");

  // 绑定供应商 + 品牌前缀兜底（p-ghost）都被删除；其他站点的供应商不动。
  assert.deepEqual(deletedProviderIds.sort(), ["p-1", "p-ghost"]);
  // 账号态与全部密钥/供应商关联清空。
  assert.equal(state.account, null);
  assert.deepEqual(state.keys, []);
  assert.deepEqual(state.providerBindings, []);
  assert.deepEqual(state.keyModels, {});
  assert.equal(state.activeKeyId, undefined);
  // 站点记录保留（MikikoCC 内置不可删）。
  assert.equal(state.siteId, "mikikocc");
  // 站点前缀的模型覆盖清空，其他站点的不受影响。
  const saved = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(join(base, ".mikiko", "v2", "sub2api.json"), "utf-8"),
  );
  assert.equal(saved.modelConfigs["mikikocc:k1:gpt-5.5"], undefined);
  assert.notEqual(saved.modelConfigs["other-site:k9:m"], undefined);
});

test("logout 供应商删除失败时抛错且不写回半清理状态", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-logout-fail-"));
  t.after(async () => {
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
          id: "mikikocc",
          kind: "mikikocc",
          panelBaseUrl: "https://mikiko.cc",
          gatewayBaseUrl: "https://api.mikiko.cc",
          siteName: "MikikoCC",
          account: { email: "u@test", balanceUsd: 1, accessToken: "tok" },
          legacyKeys: [],
          providerBindings: [{ keyId: "k1", keyName: "K1", providerId: "p-1" }],
        },
      ],
      modelConfigs: {},
    }),
  );

  let attempts = 0;
  const providerSettingsStub = {
    getView: async () => ({ revision: 1, providerTemplates: [], providerOrder: [], providers: [] }),
    deletePersonalProvider: async () => {
      attempts += 1;
      throw new Error("registry 不可用");
    },
  };
  const service = createSub2ApiService({ providerSettingsService: providerSettingsStub as never });

  await assert.rejects(service.logout("mikikocc"), /删除密钥供应商失败/);
  // 重试一次后抛错，不静默成功。
  assert.equal(attempts, 2);
  // 失败路径不写回：账号态保留在磁盘（下次可重试退出）。
  const saved = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(join(base, ".mikiko", "v2", "sub2api.json"), "utf-8"),
  );
  assert.notEqual(saved.sites[0].account, null);
});
