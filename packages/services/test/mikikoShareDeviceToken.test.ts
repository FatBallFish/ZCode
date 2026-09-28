import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@zcode/shared";
import {
  resetMikikoShareDeviceTokenCache,
  resolveMikikoShareDeviceToken,
} from "../src/conversation-share/mikikoShareDeviceToken.js";

const API_BASE_ENV_KEY = "MIKIKO_SHARE_API_BASE";

async function createHomeWithDeviceMid(): Promise<string> {
  // ensureDeviceMid({homeDir}) 读写 {home}/.mikiko/v2/telemetry-state.json；
  // 首次调用会在锁内生成 deviceMid 并写回，测试目录隔离真实用户状态。
  return mkdtemp(join(tmpdir(), "mikiko-share-token-"));
}

function createMockApiClient(
  handler: (url: URL, init?: RequestInit) => Response,
): ApiClient & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async request(input, init) {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.toString()}`);
      return handler(url, init);
    },
  };
}

function createMemoryCredentialStore() {
  const store = new Map<string, string>();
  return {
    store,
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
}

afterEach(() => {
  delete process.env[API_BASE_ENV_KEY];
  resetMikikoShareDeviceTokenCache();
});

describe("resolveMikikoShareDeviceToken", () => {
  it("注册成功：上送 deviceId 为 64 位 hex，token 持久化且进程内缓存复用", async () => {
    const home = await createHomeWithDeviceMid();
    const client = createMockApiClient((url, init) => {
      assert.equal(url.pathname, "/api/v1/shares/device/register");
      const body = JSON.parse(String(init?.body)) as { deviceId: string };
      assert.match(body.deviceId, /^[0-9a-f]{64}$/u);
      return Response.json({ code: 0, msg: "", data: { device_token: "abc.def" } });
    });
    const credentials = createMemoryCredentialStore();
    const token = await resolveMikikoShareDeviceToken({
      apiClient: client,
      credentialService: credentials,
      homeDir: home,
    });
    assert.equal(token, "abc.def");
    assert.equal(credentials.store.get("mikiko-share:device-token"), "abc.def");

    // 第二次调用走进程内缓存：不发请求。
    const tokenAgain = await resolveMikikoShareDeviceToken({
      apiClient: client,
      credentialService: credentials,
      homeDir: home,
    });
    assert.equal(tokenAgain, "abc.def");
    assert.equal(client.requests.length, 1);
  });

  it("注册失败不缓存失败态，返回 null", async () => {
    const home = await createHomeWithDeviceMid();
    const client = createMockApiClient(() => new Response("down", { status: 503 }));
    const token = await resolveMikikoShareDeviceToken({
      apiClient: client,
      credentialService: createMemoryCredentialStore(),
      homeDir: home,
    });
    assert.equal(token, null);
  });

  it("已有持久化 token 时不发起注册", async () => {
    const home = await createHomeWithDeviceMid();
    const client = createMockApiClient(() => {
      throw new Error("不应发起请求");
    });
    const credentials = createMemoryCredentialStore();
    await credentials.save("mikiko-share:device-token", "stored.token");
    const token = await resolveMikikoShareDeviceToken({
      apiClient: client,
      credentialService: credentials,
      homeDir: home,
    });
    assert.equal(token, "stored.token");
    assert.equal(client.requests.length, 0);
  });

  it("MIKIKO_SHARE_API_BASE=disabled 时返回 null（分享发布事实上禁用）", async () => {
    process.env[API_BASE_ENV_KEY] = "disabled";
    const home = await createHomeWithDeviceMid();
    const client = createMockApiClient(() => {
      throw new Error("不应发起请求");
    });
    const token = await resolveMikikoShareDeviceToken({
      apiClient: client,
      credentialService: createMemoryCredentialStore(),
      homeDir: home,
    });
    assert.equal(token, null);
  });
});
