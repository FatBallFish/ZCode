import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import {
  createExternalCdpRegistry,
  parseExternalCdpConfiguration,
  resolveInstalledBrowserExecutable,
} from "@zcode/adapters/browser";
import { setupBrowserRuntime } from "../scripts/browser-client.mjs";
import { createDesktopExternalBrowserControl } from "../../../../../packages/desktop/src/host/externalBrowserControl.js";
import {
  buildWindowsOpenFolderRegistryOperations,
  installWindowsOpenFolderContextMenu,
} from "../../../../../packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.js";
import type { BrowserCommand } from "@zcode/contracts";

/** playwright 内置 Chromium 在 macOS 上常不响应 SIGTERM（实测挂起 60s+ 甚至不退）；
 * 测试只断言浏览器死亡后的断连语义，用 SIGTERM 优雅退出 + 2s 后 SIGKILL 兜底。 */
function killTestBrowserProcess(child: import("node:child_process").ChildProcess): void {
  child.kill();
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  child.once("exit", () => clearTimeout(force));
}

test("instance configuration accepts arbitrary IDs and rejects ambiguous definitions", () => {
  const entry = { id: "custom-42", endpoint: "http://127.0.0.1:9333" };
  assert.equal(
    parseExternalCdpConfiguration(JSON.stringify({ instances: [entry] })).instances[0]?.name,
    "custom-42",
  );
  assert.deepEqual(parseExternalCdpConfiguration('{"instances":[]}').instances, []);
  for (const instances of [
    [entry, entry],
    [entry, { ...entry, id: "other" }],
    [{ ...entry, id: "Bad ID" }],
    [{ ...entry, id: "x", unknown: 1 }],
  ]) {
    assert.throws(() => parseExternalCdpConfiguration(JSON.stringify({ instances })));
  }
  assert.throws(() =>
    parseExternalCdpConfiguration('{"instances":[],"endpoint":"http://127.0.0.1:9333"}'),
  );
  assert.equal(
    parseExternalCdpConfiguration('{"endpoint":"http://127.0.0.1:9333"}').instances[0]?.id,
    "default",
  );
});

test("Windows menu registration writes only its own flavor keys without real registry IO", async () => {
  const writes = new Map<string, string[]>();
  const options = {
    platform: "win32" as const,
    executablePath: "C:\\Apps\\ZCode.exe",
    argv: [],
    isDefaultApp: false,
    locale: "en-US" as const,
    logger: { info() {}, warn() {} },
    runRegistry: async (args: readonly string[]) => {
      writes.set(args[1]! + (args[2] === "/v" ? `:${args[3]}` : ""), [...args]);
    },
  };
  await installWindowsOpenFolderContextMenu({ ...options, flavor: "production", isPackaged: true });
  const original = new Map(writes);
  await installWindowsOpenFolderContextMenu({ ...options, flavor: "preview", isPackaged: true });
  for (const [key, value] of original) assert.deepEqual(writes.get(key), value);
  assert.ok([...writes.keys()].some((key) => key.includes("Mikiko.Preview.OpenInMikiko")));
  await installWindowsOpenFolderContextMenu({
    ...options,
    flavor: "production",
    isPackaged: false,
  });
  assert.ok([...writes.keys()].some((key) => key.includes("Mikiko.Dev.OpenInMikiko")));
  const before = writes.size;
  await installWindowsOpenFolderContextMenu({
    ...options,
    platform: "linux",
    flavor: "preview",
    isPackaged: true,
  });
  assert.equal(writes.size, before);
  const preview = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    locale: "zh-CN",
    flavor: "preview",
    isPackaged: true,
  });
  assert.ok(preview.every((op) => op.args[1]?.includes("Mikiko.Preview.OpenInMikiko")));
  assert.ok(preview.some((op) => op.args.includes("在 Mikiko Preview 中打开")));
  assert.ok(preview.every((op) => op.args[0] === "add"));
  const dev = buildWindowsOpenFolderRegistryOperations({
    executablePath: "C:\\Electron\\electron.exe",
    appArgs: ["C:\\Dev Space\\app"],
    locale: "en-US",
    flavor: "preview",
    isPackaged: false,
  });
  assert.ok(
    dev.some((op) =>
      op.args.includes('"C:\\Electron\\electron.exe" "C:\\Dev Space\\app" --open-workspace "%1"'),
    ),
  );
});

test(
  "three arbitrary external instances use exact SDK IDs and independent contexts",
  { timeout: 90_000 },
  async (t) => {
    const executable = resolveInstalledBrowserExecutable({ chromium });
    const ids = ["alpha", "beta", "custom-42"];
    const browsers = [];
    for (const id of ids) {
      const profile = await mkdtemp(join(tmpdir(), "zcode-multi-test-"));
      const child = spawn(
        executable,
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
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          killTestBrowserProcess(child);
          await exited;
        }
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      });
      const endpoint = await new Promise<string>((accept, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Test Chromium startup timed out")),
          15_000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stderr.on("data", (chunk) => {
          const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
          if (match) {
            clearTimeout(timer);
            accept(`http://127.0.0.1:${match[1]}`);
          }
        });
      });
      const observer = await chromium.connectOverCDP(endpoint);
      t.after(async () => {
        await observer.close();
      });
      browsers.push({ id, endpoint, observer, userPage: observer.contexts()[0]!.pages()[0]! });
    }
    const unavailable = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    unavailable.listen(0, "127.0.0.1");
    await once(unavailable, "listening");
    t.after(() => {
      unavailable.close();
    });
    const address = unavailable.address();
    assert.ok(address && typeof address !== "string");
    const configuration = JSON.stringify({
      instances: [
        ...browsers.map(({ id, endpoint }) => ({ id, endpoint, name: `Test ${id}` })),
        { id: "unavailable", endpoint: `http://127.0.0.1:${address.port}` },
      ],
    });
    const registry = createExternalCdpRegistry(parseExternalCdpConfiguration(configuration));
    t.after(async () => {
      await registry.close();
    });
    const port = registry.browserControlPort;
    const globals: Record<PropertyKey, unknown> = {};
    globals[Symbol.for("zcode.node-repl.browser-control-bridge")] = {
      assertAvailable() {},
      documentationRoot: resolve(import.meta.dirname, ".."),
      list: () => port.list({ sessionId: "task" }),
      execute: (browserId: string, browserGeneration: number, command: BrowserCommand) =>
        port.execute({ browserId, browserGeneration, command, sessionId: "task" }),
    };
    await setupBrowserRuntime({ globals });
    const agent = globals.agent as {
      browsers: {
        list(): Promise<{ id: string; name: string }[]>;
        get(
          id: string,
        ): Promise<{ tabs: { new (): Promise<{ id: string; goto(url: string): Promise<void> }> } }>;
        getDefault(): Promise<unknown>;
        getForUrl(url: string): Promise<unknown>;
      };
    };
    const descriptors = await agent.browsers.list();
    assert.deepEqual(
      descriptors.map((item) => item.id),
      ids.map((id) => `cdp:external:${id}`),
    );
    assert.equal(descriptors[2]?.name, "Test custom-42");
    await assert.rejects(agent.browsers.get("cdp"), /ambiguous/);
    await assert.rejects(agent.browsers.getDefault(), /explicit/);
    await assert.rejects(agent.browsers.getForUrl("http://example.invalid"), /explicit/);
    const created = [];
    for (const descriptor of descriptors) {
      const browser = await agent.browsers.get(descriptor.id);
      const tab = await browser.tabs.new();
      await tab.goto("about:blank");
      created.push({ descriptor, tab });
    }
    const discovered = await port.list({ sessionId: "task" });
    const beta = discovered[1]!;
    assert.equal(
      (
        await port.execute({
          browserId: beta.id,
          browserGeneration: beta.generation,
          sessionId: "task",
          command: { method: "close", tabId: created[0]!.tab.id },
        })
      ).ok,
      false,
    );
    for (const descriptor of discovered)
      assert.equal(
        (
          await port.execute({
            browserId: descriptor.id,
            browserGeneration: descriptor.generation,
            sessionId: "task",
            command: { method: "list" },
          })
        ).tabs?.length,
        1,
      );
    const iab = {
      list: async () => [{ ...discovered[0]!, id: "iab:test", type: "iab" as const }],
      execute: async () => ({ ok: true, elapsedMs: 0 }),
    };
    const desktop = createDesktopExternalBrowserControl(iab, configuration);
    const scope = {
      sessionId: "desktop",
      workspaceIdentity: "local-workspace",
      sessionContext: "live" as const,
    };
    assert.deepEqual(
      (await desktop.list(scope)).map((item) => item.id),
      ["iab:test", ...ids.map((id) => `cdp:external:${id}`)],
    );
    await desktop.close();
    await port.closeSession?.({ sessionId: "task" });
    for (const browser of browsers) {
      assert.equal(browser.userPage.isClosed(), false);
      assert.equal(browser.observer.contexts()[0]!.pages().length, 1);
    }
    await registry.close();
    for (const browser of browsers) assert.equal(browser.observer.isConnected(), true);
    const replacement = createExternalCdpRegistry(parseExternalCdpConfiguration(configuration));
    const replaced = await replacement.browserControlPort.list({ sessionId: "replacement" });
    assert.deepEqual(
      replaced.map((item) => item.id),
      ids.map((id) => `cdp:external:${id}`),
    );
    assert.notEqual(replaced[0]!.generation, discovered[0]!.generation);
    assert.equal(
      (
        await replacement.browserControlPort.execute({
          browserId: discovered[0]!.id,
          browserGeneration: discovered[0]!.generation,
          sessionId: "replacement",
          command: { method: "newTab" },
        })
      ).error?.code,
      "backend_unavailable",
    );
    await replacement.close();
  },
);

test(
  "applyConfiguration hot-swaps instances without restart and rejects stale generations",
  { timeout: 60_000 },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), "zcode-hotswap-test-"));
    const executablePath = resolveInstalledBrowserExecutable({ chromium });
    const child = spawn(
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
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        killTestBrowserProcess(child);
        await exited;
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const endpoint = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Test Chromium startup timed out")), 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stderr.on("data", (chunk) => {
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
        if (match) {
          clearTimeout(timer);
          accept(`http://127.0.0.1:${match[1]}`);
        }
      });
    });
    const observer = await chromium.connectOverCDP(endpoint);
    t.after(async () => {
      await observer.close();
    });
    const iab = {
      list: async () => [
        { id: "iab:test", generation: 1, type: "iab" as const, name: "IAB", capabilities: {} },
      ],
      execute: async () => ({ ok: true, elapsedMs: 0 }),
    };
    const host = createDesktopExternalBrowserControl(
      iab,
      JSON.stringify({ instances: [{ id: "before", endpoint }] }),
    );
    t.after(async () => {
      await host.close();
    });
    const scope = {
      sessionId: "hotswap",
      workspaceIdentity: "workspace-hotswap",
      sessionContext: "live" as const,
    };
    const [before] = (await host.list(scope)).filter((item) => item.type === "cdp");
    assert.equal(before?.id, "cdp:external:before");
    // 配置变更（实例 id 换成 after）：热重建，旧 generation/ID 失效，新 ID 立即可发现。
    await host.applyConfiguration(
      JSON.stringify({ instances: [{ id: "after", endpoint }] }),
      true,
    );
    const descriptors = await host.list(scope);
    const after = descriptors.find((item) => item.id === "cdp:external:after");
    assert.ok(after);
    assert.equal(descriptors.some((item) => item.id === "cdp:external:before"), false);
    const stale = await host.execute({
      ...scope,
      browserId: before.id,
      browserGeneration: before.generation,
      command: { method: "newTab" },
    });
    assert.equal(stale.error?.code, "backend_unavailable");
    const fresh = await host.execute({
      ...scope,
      browserId: after.id,
      browserGeneration: after.generation,
      command: { method: "newTab" },
    });
    assert.ok(fresh.tab);
    await host.execute({
      ...scope,
      browserId: after.id,
      browserGeneration: after.generation,
      command: { method: "closeSession" },
    });
    // 浏览器进程与用户页面在热重建后仍存活（安全 detach）。
    assert.equal(observer.isConnected(), true);
    assert.equal(observer.contexts()[0]!.pages().length, 1);
  },
);
