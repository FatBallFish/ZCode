import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

import { createExternalCdpBrowserRuntime } from "@zcode/adapters/browser";
import type { BrowserBackendDescriptor } from "@zcode/shared";
import { createDesktopExternalBrowserControl } from "../../../../../packages/desktop/src/host/externalBrowserControl.js";

/**
 * 客户反馈（Windows，2026-10-11）：外部 CDP 端点不可用时，新会话首条消息前的
 * ambient 发现重复付满 10s+10s 握手超时。这组测试覆盖两个修复：
 * 1. connect 失败短 TTL 负缓存（不再重复握手）；
 * 2. AbortSignal 贯穿 desktop 包装层 → registry → 端口（ambient deadline 能立即止损）。
 */

/** 短暂占用后立即释放：该端口短期内连接必被立即拒绝（ECONNREFUSED）。 */
async function refusedLoopbackEndpoint(): Promise<string> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://127.0.0.1:${address.port}`;
}

/** 监听但永不响应 /json/version：握手会挂满 fetch 的 10s 超时（模拟挂死/被墙的端点）。 */
async function silentLoopbackServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  // 本环境 net.Server 没有 closeAllConnections（实测 undefined），手动跟踪 socket 销毁。
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // 故意既不响应也不断开。
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** close 可能还要等挂死的握手 fetch 超时（10s）；测试只等一小会儿，剩余交给 --test-force-exit。 */
function closeWithoutWaiting(close: () => Promise<void>): Promise<unknown> {
  return Promise.race([
    close().catch(() => undefined),
    new Promise((done) => setTimeout(done, 200)),
  ]);
}

test("connect failure is negatively cached within TTL and retried after expiry", async () => {
  const endpoint = await refusedLoopbackEndpoint();
  const runtime = createExternalCdpBrowserRuntime({ endpoint, connectFailureCacheMs: 200 });
  const port = runtime.browserControlPort;
  try {
    // 第一次：真实握手（loopback 立即 ECONNREFUSED），失败时间被记录。
    await assert.rejects(port.list({ sessionId: "s" }));
    // TTL 内：不再重复握手，直接以负缓存错误拒绝。
    const startedAt = Date.now();
    await assert.rejects(port.list({ sessionId: "s" }), /failed recently/);
    assert.ok(Date.now() - startedAt < 150);
    // TTL 过期：恢复真实重试（错误不再来自负缓存）。
    await new Promise((done) => setTimeout(done, 250));
    await assert.rejects(port.list({ sessionId: "s" }), (error: Error) => {
      assert.equal(/failed recently/.test(error.message), false);
      return true;
    });
  } finally {
    await runtime.close();
  }
});

test("abort signal stops waiting for a hung CDP handshake", async () => {
  const server = await silentLoopbackServer();
  const runtime = createExternalCdpBrowserRuntime({ endpoint: server.endpoint });
  const port = runtime.browserControlPort;
  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    const listing = port.list({ sessionId: "s", signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(listing);
    // abort 未生效时会挂满 10s fetch 超时。
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    await closeWithoutWaiting(() => runtime.close());
    await server.close();
  }
});

test("desktop host control forwards ambient abort signal to external registry", async () => {
  const server = await silentLoopbackServer();
  const iabDescriptor: BrowserBackendDescriptor = {
    id: "iab:test",
    generation: 1,
    type: "iab",
    name: "IAB",
    capabilities: {},
  };
  const iab = {
    list: async () => [iabDescriptor],
    execute: async () => ({ ok: true, elapsedMs: 0 }),
  };
  const host = createDesktopExternalBrowserControl(iab, JSON.stringify({ endpoint: server.endpoint }));
  try {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    // signal 未转发到 registry 时，这里会挂满 10s 握手超时而不是立即取消。
    await assert.rejects(
      host.list({ sessionId: "s", signal: controller.signal }),
      /External discovery cancelled/,
    );
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    await closeWithoutWaiting(() => host.close());
    await server.close();
  }
});
