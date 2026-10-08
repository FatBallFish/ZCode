import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
import {
  createExternalCdpBrowserRuntime,
  validateExternalEndpoint,
  parseExternalCdpOptions,
  resolveExternalEndpoint,
  createManagedCdpBrowserRuntime,
  resolveInstalledBrowserExecutable,
} from "@zcode/adapters/browser";
import { setupBrowserRuntime } from "../scripts/browser-client.mjs";
import type { BrowserCommand } from "@zcode/contracts";
import { ExternalCdpSession } from "../../adapters/src/browser/external-session.js";
import { createDesktopExternalBrowserControl } from "../../../../../packages/desktop/src/host/externalBrowserControl.js";
/** playwright 内置 Chromium 在 macOS 上常不响应 SIGTERM（实测挂起 60s+ 甚至不退）；
 * 测试只断言浏览器死亡后的断连语义，用 SIGTERM 优雅退出 + 2s 后 SIGKILL 兜底。 */
function killTestBrowserProcess(child: import("node:child_process").ChildProcess): void {
  child.kill();
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  child.once("exit", () => clearTimeout(force));
}

test("external configuration only accepts explicit literal loopback origins", () => {
  for (const value of [
    "http://localhost:9333",
    "http://192.168.1.2:9333",
    "http://127.1:9333",
    "http://2130706433:9333",
    "http://127.0.0.1",
    "https://127.0.0.1:9333",
    "http://user:pass@127.0.0.1:9333",
    "http://127.0.0.1:9333/path",
    "http://127.0.0.1:9333/?x=1",
  ]) {
    assert.throws(() => validateExternalEndpoint(value));
  }
  assert.equal(validateExternalEndpoint("http://127.0.0.1:9333").port, "9333");
  assert.equal(validateExternalEndpoint("http://[::1]:9333").hostname, "[::1]");
  assert.throws(() =>
    parseExternalCdpOptions('{"endpoint":"http://127.0.0.1:9333","unknown":true}'),
  );
});

test("handshake rejects redirects, non-Chromium, remote WebSocket and replacement identity", async () => {
  let mode = "redirect";
  const server = createServer((_request, response) => {
    if (mode === "redirect") {
      response.writeHead(302, { Location: "http://example.invalid/" });
      response.end();
      return;
    }
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    response.end(
      JSON.stringify({
        Browser: mode === "product" ? "Firefox/1" : "Chrome/1",
        webSocketDebuggerUrl: `ws://${mode === "remote" ? "192.168.1.2" : "127.0.0.1"}:${address.port}/devtools/browser/test-id`,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    for (mode of ["redirect", "product", "remote"])
      await assert.rejects(resolveExternalEndpoint(endpoint));
    mode = "valid";
    await assert.rejects(resolveExternalEndpoint(endpoint, "different-id"));
    assert.equal((await resolveExternalEndpoint(endpoint)).browserId, "test-id");
  } finally {
    server.close();
  }
});

test(
  "official SDK external attach isolates pages and safely detaches",
  { timeout: 60_000 },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), "zcode-external-test-"));
    const executablePath = resolveInstalledBrowserExecutable({ chromium });
    const process = spawn(
      executablePath,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    t.after(async () => {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = once(process, "exit");
        killTestBrowserProcess(process);
        await exited;
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const endpoint = await new Promise<string>((accept, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Test Chromium startup timed out")), 15_000);
      process.once("error", reject);
      process.stderr.on("data", (chunk) => {
        output += String(chunk);
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          accept(`http://127.0.0.1:${match[1]}`);
        }
      });
    });
    const observer = await chromium.connectOverCDP(endpoint);
    const context = observer.contexts()[0]!;
    const userPage = context.pages()[0]!;
    const fixture = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<title>Fixture</title><button id="popup" onclick="window.open(\'/child\')">Popup</button>',
      );
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    await userPage.goto(url);
    // Synthetic session state, not cookies or any user's profile.
    await userPage.evaluate(() => localStorage.setItem("fixture-login", "test-session"));
    const runtime = createExternalCdpBrowserRuntime({ endpoint, name: "Test external" });
    const port = runtime.browserControlPort;
    const [descriptor] = await port.list({ sessionId: "a" });
    assert.ok(descriptor);
    const execute = (sessionId: string, command: BrowserCommand) =>
      port.execute({
        browserId: descriptor.id,
        browserGeneration: descriptor.generation,
        sessionId,
        command,
      });
    try {
      assert.equal((await execute("a", { method: "list" })).tabs?.length, 0);
      const globals: Record<string, unknown> = {};
      globals[Symbol.for("zcode.node-repl.browser-control-bridge") as unknown as string] = {
        assertAvailable() {},
        documentationRoot: resolve(import.meta.dirname, ".."),
        list: () => port.list({ sessionId: "a" }),
        execute: (browserId, browserGeneration, command) =>
          port.execute({ browserId, browserGeneration, sessionId: "a", command }),
      };
      await setupBrowserRuntime({ globals });
      const agent = globals.agent as {
        browsers: {
          get(id: string): Promise<{
            tabs: {
              new (): Promise<{
                id: string;
                goto(url: string): Promise<void>;
                playwright: { evaluate(expression: string): Promise<unknown> };
              }>;
            };
          }>;
        };
      };
      const browser = await agent.browsers.get(descriptor.id);
      const tab = await browser.tabs.new();
      await tab.goto(url);
      assert.equal(
        await tab.playwright.evaluate("localStorage.getItem('fixture-login')"),
        "test-session",
      );
      assert.equal((await execute("b", { method: "close", tabId: tab.id })).ok, false);
      assert.equal(userPage.isClosed(), false);
      const unrelated = await context.newPage();
      assert.equal((await execute("a", { method: "list" })).tabs?.length, 1);
      await execute("a", {
        method: "evaluate",
        tabId: tab.id,
        expression: "window.open('/child')",
      });
      await new Promise((done) => setTimeout(done, 200));
      assert.equal((await execute("a", { method: "list" })).tabs?.length, 2);
      assert.equal((await execute("b", { method: "list" })).tabs?.length, 0);
      await port.closeSession?.({ sessionId: "a" });
      assert.equal(userPage.isClosed(), false);
      assert.equal(unrelated.isClosed(), false);
      assert.equal((await execute("a", { method: "newTab" })).ok, false);
      await runtime.close();
      assert.equal(observer.isConnected(), true);
      assert.equal(userPage.isClosed(), false);
      assert.equal(process.exitCode, null);
      const replacement = await chromium.connectOverCDP(endpoint);
      await replacement.close();
      assert.equal(observer.isConnected(), true);
      const managed = createManagedCdpBrowserRuntime({ executablePath });
      const [managedDescriptor] = await managed.browserControlPort.list({ sessionId: "managed" });
      assert.equal(managedDescriptor?.metadata?.launchMode, "managed");
      await managed.close();
      const iab = {
        list: async () => [{ ...descriptor, id: "iab:test", type: "iab" as const }],
        execute: async () => ({ ok: true, elapsedMs: 0 }),
      };
      // 显式空数组才是禁用；不配置时走内置默认 9333（禁用语义必须显式表达）。
      const disabled = createDesktopExternalBrowserControl(iab, '{"instances":[]}');
      assert.equal((await disabled.list({ sessionId: "disabled" })).length, 1);
      await disabled.close();
      const host = createDesktopExternalBrowserControl(iab, JSON.stringify({ endpoint }));
      const scope = {
        sessionId: "same",
        workspaceIdentity: "workspace-a",
        sessionContext: "live" as const,
      };
      const descriptors = await host.list(scope);
      assert.equal(descriptors[0]?.type, "iab");
      const external = descriptors[1]!;
      const owned = await host.execute({
        ...scope,
        browserId: external.id,
        browserGeneration: external.generation,
        command: { method: "newTab" },
      });
      assert.ok(owned.tab);
      assert.equal(
        (
          await host.execute({
            ...scope,
            workspaceIdentity: "workspace-b",
            browserId: external.id,
            browserGeneration: external.generation,
            command: { method: "close", tabId: owned.tab.tabId },
          })
        ).ok,
        false,
      );
      // 远控 live 链路默认可见 external（与 IAB 同等信任）；cached 回放上下文不可见。
      assert.equal((await host.list({ ...scope, remoteSessionId: "remote" })).length, 2);
      assert.equal(
        (await host.list({ ...scope, remoteSessionId: "remote", sessionContext: "cached" }))
          .length,
        1,
      );
      const remoteTab = await host.execute({
        ...scope,
        remoteSessionId: "remote-1",
        browserId: external.id,
        browserGeneration: external.generation,
        command: { method: "newTab" },
      });
      assert.ok(remoteTab.tab);
      // 关闭远控开关（热更新，配置不变不重建）：远控 live 不可见，桌面本地不受影响。
      await host.applyConfiguration(JSON.stringify({ endpoint }), false);
      assert.equal((await host.list({ ...scope, remoteSessionId: "remote" })).length, 1);
      assert.equal(
        (
          await host.execute({
            ...scope,
            remoteSessionId: "remote",
            browserId: external.id,
            browserGeneration: external.generation,
            command: { method: "newTab" },
          })
        ).error?.code,
        "backend_unavailable",
      );
      assert.equal((await host.list(scope)).length, 2);
      await host.applyConfiguration(JSON.stringify({ endpoint }), true);
      assert.equal((await host.list({ ...scope, remoteSessionId: "remote" })).length, 2);
      const waiting = host.execute({
        ...scope,
        requestId: "cancel-me",
        browserId: external.id,
        browserGeneration: external.generation,
        command: { method: "playwrightWaitForTimeout", timeoutMs: 1000 },
      });
      await host.execute({
        ...scope,
        browserId: external.id,
        browserGeneration: external.generation,
        command: { method: "cancelRequest", requestId: "cancel-me" },
      });
      assert.equal((await waiting).error?.code, "cancelled");
      await host.close();
      assert.equal(userPage.isClosed(), false);
      const lateSession = new ExternalCdpSession(context);
      const creating = lateSession.createTab();
      const rejected = assert.rejects(creating);
      await lateSession.close();
      await rejected;
      assert.equal(userPage.isClosed(), false);
      const disconnected = createExternalCdpBrowserRuntime({ endpoint });
      const [old] = await disconnected.browserControlPort.list({ sessionId: "disconnect" });
      assert.ok(old);
      const aborted = new AbortController();
      aborted.abort();
      assert.equal(
        (
          await disconnected.browserControlPort.execute({
            browserId: old.id,
            browserGeneration: old.generation,
            sessionId: "disconnect",
            signal: aborted.signal,
            command: { method: "newTab" },
          })
        ).error?.code,
        "cancelled",
      );
      const exited = once(process, "exit");
      assert.equal(
        (
          await disconnected.browserControlPort.execute({
            browserId: old.id,
            browserGeneration: old.generation - 1,
            sessionId: "disconnect",
            command: { method: "newTab" },
          })
        ).error?.code,
        "backend_unavailable",
      );
      const identity = (await resolveExternalEndpoint(endpoint)).browserId;
      const pinnedWrong = createExternalCdpBrowserRuntime({
        endpoint,
        expectedBrowserId: "wrong-identity",
      });
      await assert.rejects(pinnedWrong.browserControlPort.list({ sessionId: "wrong" }));
      await pinnedWrong.close();
      assert.ok(identity);
      const turnRequest = disconnected.browserControlPort.execute({
        browserId: old.id,
        browserGeneration: old.generation,
        sessionId: "cancel-turn",
        turnId: "turn-1",
        command: { method: "playwrightWaitForTimeout", timeoutMs: 500 },
      });
      await disconnected.browserControlPort.turnEnded?.({
        sessionId: "cancel-turn",
        turnId: "turn-1",
      });
      assert.equal((await turnRequest).error?.code, "cancelled");
      killTestBrowserProcess(process);
      await exited;
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(
        (
          await disconnected.browserControlPort.execute({
            browserId: old.id,
            browserGeneration: old.generation,
            sessionId: "disconnect",
            command: { method: "newTab" },
          })
        ).error?.code,
        "backend_unavailable",
      );
      await disconnected.close();
    } finally {
      await runtime.close();
      await observer.close();
      fixture.close();
      if (process.exitCode === null && process.signalCode === null) {
        const exited = once(process, "exit");
        killTestBrowserProcess(process);
        await exited;
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);
