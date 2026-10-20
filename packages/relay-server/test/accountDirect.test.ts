import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { startRelayServer } from "../src/server.js";
import { __setJwksForTests } from "../src/oidcVerify.js";

/**
 * Mikiko ID 账号直连（方案 Part E.3）：设备认领、账号设备列表、
 * 免票据直连签发（复用 issueSession + bindTicket 状态机）。
 * JWKS 走注入（本地 RSA 签名），不经网络。
 */

const ISSUER = "https://id.test/realm";

const keyPair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
__setJwksForTests(ISSUER, [{ ...publicJwk, kid: "test-key", use: "sig" }]);

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const payload = {
    iss: ISSUER,
    azp: "mikiko_remote",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  };
  const b64u = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64u(header)}.${b64u(payload)}`;
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(new Uint8Array(signature)).toString("base64url")}`;
}

const USER_A = await signToken({ sub: "user-a" });
const USER_B = await signToken({ sub: "user-b" });

interface RelayHandle {
  port: number;
  state: { devices: Map<string, unknown>; desktopRoutes: Map<string, unknown> };
  close(): Promise<void>;
}

async function withServer(run: (handle: RelayHandle) => Promise<void>): Promise<void> {
  const handle = await startRelayServer({
    secret: "test-secret",
    webRemoteBase: "https://remote.mikiko.ai",
    publicWsBase: "wss://ws.mikiko.ai",
    oidcIssuer: ISSUER,
    port: 0,
    host: "127.0.0.1",
  });
  try {
    await run(handle as unknown as RelayHandle);
  } finally {
    await handle.close();
  }
}

async function call(
  handle: RelayHandle,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, init);
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

test("账号端点：设备注册带 Bearer 认领；devices 只见本人；claim 冲突拒绝", async () => {
  await withServer(async (handle) => {
    // 1) 桌面 A 以 user-a 身份注册（注册即认领）。
    const registered = await call(handle, "/api/rc/devices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A}` },
      body: JSON.stringify({ mid: "mid-a", name: "MacBook", appVersion: "1.0.0" }),
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.body.claimed, true);

    // 2) 桌面 B 匿名注册后由 user-b 显式认领。
    await call(handle, "/api/rc/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mid: "mid-b", name: "Mini", appVersion: "1.0.0" }),
    });
    const claimed = await call(handle, "/api/rc/devices/claim", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_B}` },
      body: JSON.stringify({ mid: "mid-b" }),
    });
    assert.equal(claimed.status, 200);

    // 3) user-b 抢 user-a 的设备 → 409 already_owned。
    const hijack = await call(handle, "/api/rc/devices/claim", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_B}` },
      body: JSON.stringify({ mid: "mid-a" }),
    });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.body.error, "already_owned");

    // 4) devices 按归属过滤；在线状态 = desktopRoutes（未连接桌面 → false）。
    const mine = await call(handle, "/api/rc/account/devices", {
      headers: { authorization: `Bearer ${USER_A}` },
    });
    assert.equal(mine.status, 200);
    const devices = mine.body.devices as Array<{ mid: string; online: boolean }>;
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.mid, "mid-a");
    assert.equal(devices[0]?.online, false);

    // 5) 无 Bearer → 401；坏签名 → 401。
    const anonymous = await call(handle, "/api/rc/account/devices", {});
    assert.equal(anonymous.status, 401);
    const forged = await call(handle, "/api/rc/account/devices", {
      headers: { authorization: `Bearer ${USER_A.slice(0, -8)}AAAAAAAA` },
    });
    assert.equal(forged.status, 401);
  });
});

test("账号直连：归属校验 + 桌面离线 409 + 在线签发 sid/sessionToken（免票据）", async () => {
  await withServer(async (handle) => {
    await call(handle, "/api/rc/devices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A}` },
      body: JSON.stringify({ mid: "mid-a", name: "MacBook", appVersion: "1.0.0" }),
    });

    // 非本人设备 → 403。
    const foreign = await call(handle, "/api/rc/account/connect", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_B}` },
      body: JSON.stringify({ mid: "mid-a" }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, "device_not_owned");

    // 桌面离线 → 409 desktop_offline。
    const offline = await call(handle, "/api/rc/account/connect", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A}` },
      body: JSON.stringify({ mid: "mid-a" }),
    });
    assert.equal(offline.status, 409);
    assert.equal(offline.body.error, "desktop_offline");

    // 模拟桌面长连在线（desktopRoutes 注册即可；直连复用状态机，不依赖真实 WS 帧面）。
    handle.state.desktopRoutes.set("mid-a", { nextStreamId: 1 });
    const connected = await call(handle, "/api/rc/account/connect", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${USER_A}` },
      body: JSON.stringify({ mid: "mid-a" }),
    });
    assert.equal(connected.status, 200);
    assert.ok(typeof connected.body.sid === "string" && (connected.body.sid as string).length > 0);
    assert.ok(typeof connected.body.sessionToken === "string");
    assert.equal(connected.body.relayWsBase, "wss://ws.mikiko.ai");
  });
});
