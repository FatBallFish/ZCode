import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSub2ApiService } from "../src/sub2api/sub2apiService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * 余额更新广播（specs/desktop/sub2api-gateway.md「余额更新广播」2026-10-02）：
 * getAccountDetail 是余额轮询入口；账号三字段（balanceUsd/frozenUsd/totalRechargedUsd）
 * 实际变化时必须 saveConfig 落盘并广播 onDidChange（footer 只靠它更新余额），
 * 未变化时零 IO 零事件（防「订阅 → 重拉 → 再写盘」高频闪环）。
 */

const realFetch = globalThis.fetch;

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface MeUser {
  balance?: number;
  frozen_balance?: number;
  total_recharged?: number;
}

async function seedConfig(base: string, balanceUsd: number): Promise<string> {
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  const configFile = join(base, ".mikiko", "v2", "sub2api.json");
  await writeFile(
    configFile,
    JSON.stringify({
      version: 2,
      sites: [
        {
          id: "mikikocc",
          kind: "mikikocc",
          panelBaseUrl: "https://mikiko.cc",
          gatewayBaseUrl: "https://api.mikiko.cc",
          siteName: "MikikoCC",
          account: { email: "u@test", balanceUsd, accessToken: "tok" },
          legacyKeys: [],
        },
      ],
      modelConfigs: {},
    }),
  );
  return configFile;
}

function mockPanelFetch(meUser: MeUser): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/auth/me")) {
      return envelope({ user: meUser });
    }
    if (url.includes("/api/v1/console/bootstrap")) {
      return envelope({ wallet: {} });
    }
    if (url.includes("/api/v1/groups/available")) {
      return envelope([]);
    }
    if (url.includes("/api/v1/subscriptions")) {
      return envelope([]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function createService() {
  return createSub2ApiService({
    providerSettingsService: {
      getView: async () => ({
        revision: 1,
        providerTemplates: [],
        providerOrder: [],
        providers: [],
      }),
    } as never,
  });
}

test("getAccountDetail 余额变化 → 落盘并广播 onDidChange", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-balance-broadcast-"));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  const configFile = await seedConfig(base, 1);
  mockPanelFetch({ balance: 5.5, frozen_balance: 0.5, total_recharged: 10 });

  const service = createService();
  const events: Array<Array<{ siteId: string; balance: number | undefined }>> = [];
  const disposable = service.onDidChange((state) => {
    events.push(
      state.sites.map((site) => ({ siteId: site.siteId, balance: site.account?.balanceUsd })),
    );
  });

  const detail = await service.getAccountDetail("mikikocc");

  assert.equal(detail.account.balanceUsd, 5.5);
  assert.equal(events.length, 1, "余额变化必须广播恰好一次");
  assert.equal(events[0]?.[0]?.balance, 5.5);
  const onDisk = JSON.parse(await readFile(configFile, "utf-8")) as {
    sites: Array<{ account?: { balanceUsd?: number } }>;
  };
  assert.equal(onDisk.sites[0]?.account?.balanceUsd, 5.5, "新余额必须写盘");
  const sites = await service.getSites();
  assert.equal(sites.sites[0]?.account?.balanceUsd, 5.5);
  disposable.dispose();
});

test("getAccountDetail 余额未变 → 不广播、不写盘", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-balance-silent-"));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  const configFile = await seedConfig(base, 5.5);
  mockPanelFetch({ balance: 5.5 });

  const service = createService();
  const events: unknown[] = [];
  const disposable = service.onDidChange((state) => events.push(state));
  const before = await readFile(configFile, "utf-8");

  const detail = await service.getAccountDetail("mikikocc");

  assert.equal(detail.account.balanceUsd, 5.5);
  assert.equal(events.length, 0, "余额未变不得广播");
  const after = await readFile(configFile, "utf-8");
  assert.equal(after, before, "余额未变不得写盘");
  disposable.dispose();
});
