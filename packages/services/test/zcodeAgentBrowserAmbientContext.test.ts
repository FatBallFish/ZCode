<<<<<<< HEAD
import { describe, expect, it, vi } from "vitest";
=======
import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserBackendDescriptor } from "@zcode/shared";
>>>>>>> b65bb69d (fix(desktop): 外部 CDP 不可达不再阻塞新会话（ambient 1.5s deadline + 连接失败 10s 负缓存 + abort 贯穿）)
import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "../src/zcode-agent/zcodeAgentBrowserAmbientContext.js";

<<<<<<< HEAD
const descriptor = {
  id: "iab-runtime",
  generation: 7,
  type: "iab" as const,
  name: "ZCode In-app Browser",
  capabilities: {},
};

describe("collectBrowserAmbientContext", () => {
  it("merges controlled and user tabs and preserves remote routing context", async () => {
    const list = vi.fn(async () => [descriptor]);
    const execute = vi.fn(async (input: { command: { method: string } }) =>
      input.command.method === "list"
        ? {
            ok: true,
            tabs: [
              {
                tabId: "controlled-1",
                url: "https://example.com/background",
                title: "Background",
                viewport: { width: 1280, height: 720 },
              },
            ],
            elapsedMs: 0,
          }
        : {
            ok: true,
            userTabs: [
              {
                id: "user-1",
                url: "https://user:password@example.com/current?q=1",
                title: "Current",
              },
            ],
            elapsedMs: 0,
          },
    );
    const executor = {
      list,
      execute,
    } as unknown as BrowserAmbientContextExecutor;

    await expect(
      collectBrowserAmbientContext(executor, {
        sessionId: "sess-1",
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:dev:/workspace",
        remoteSessionId: "remote-1",
        clientMode: "web-remote-replayable",
      }),
    ).resolves.toEqual({
      tabCount: 2,
      currentUrl: "https://example.com/current?q=1",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: "remote:ssh:dev:/workspace",
        remoteSessionId: "remote-1",
        clientMode: "web-remote-replayable",
      }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        browserId: "iab-runtime",
        browserGeneration: 7,
        workspaceIdentity: "remote:ssh:dev:/workspace",
        remoteSessionId: "remote-1",
        clientMode: "web-remote-replayable",
      }),
    );
  });

  it("prefers an active controlled tab and degrades when the bridge fails", async () => {
    const executor: BrowserAmbientContextExecutor = {
      list: vi.fn(async () => [descriptor]),
      execute: vi.fn(async (input) =>
        input.command.method === "list"
          ? {
              ok: true,
              tabs: [
                {
                  tabId: "controlled-1",
                  url: "https://example.com/active",
                  title: "Active",
                  active: true,
                  viewport: { width: 1280, height: 720 },
                },
              ],
              elapsedMs: 0,
            }
          : { ok: true, userTabs: [], elapsedMs: 0 },
      ),
    };
    await expect(
      collectBrowserAmbientContext(executor, {
        sessionId: "sess-1",
        workspacePath: "/workspace",
      }),
    ).resolves.toEqual({
      tabCount: 1,
      currentUrl: "https://example.com/active",
    });

    await expect(
      collectBrowserAmbientContext(
        {
          list: vi.fn(async () => {
            throw new Error("bridge unavailable");
          }),
          execute: vi.fn(),
        },
        { sessionId: "sess-1", workspacePath: "/workspace" },
      ),
    ).resolves.toBeUndefined();
  });
=======
const IAB_DESCRIPTOR: BrowserBackendDescriptor = {
  id: "iab:test",
  generation: 1,
  type: "iab",
  name: "IAB",
  capabilities: {},
};

test("ambient context gives up at deadline instead of blocking prompt forwarding", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const executor: BrowserAmbientContextExecutor = {
    list: async (input) => {
      signals.push(input.signal);
      // 永不 settle：模拟外部 CDP 端点挂死（握手挂满 10s fetch 超时），
      // 旧实现会让新会话首条消息一直卡在这里直到超时（Windows 客户反馈）。
      return new Promise<BrowserBackendDescriptor[]>(() => {});
    },
    execute: async () => ({ ok: true, elapsedMs: 0 }),
  };
  const startedAt = Date.now();
  const result = await collectBrowserAmbientContext(
    executor,
    { sessionId: "s1", workspacePath: "/w" },
    { deadlineMs: 50 },
  );
  assert.equal(result, undefined);
  // deadline 必须远小于外部 CDP 的 10s 握手超时，消息转发不再被卡住。
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(signals.length, 1);
  assert.equal(signals[0] instanceof AbortSignal, true);
  assert.equal(signals[0]?.aborted, true);
});

test("ambient context still collects tabs from a healthy executor", async () => {
  const seenSignals: (AbortSignal | undefined)[] = [];
  const executor: BrowserAmbientContextExecutor = {
    list: async (input) => {
      seenSignals.push(input.signal);
      return [IAB_DESCRIPTOR];
    },
    execute: async (input) => {
      seenSignals.push(input.signal);
      if (input.command.method === "list") {
        return {
          ok: true,
          elapsedMs: 0,
          tabs: [
            {
              tabId: "t1",
              url: "https://example.com/",
              title: "Example",
              viewport: { width: 1280, height: 800 },
              active: true,
            },
          ],
        };
      }
      return { ok: true, elapsedMs: 0, userTabs: [{ id: "u1", url: "https://example.org/" }] };
    },
  };
  const result = await collectBrowserAmbientContext(executor, {
    sessionId: "s1",
    workspacePath: "/w",
  });
  assert.deepEqual(result, { tabCount: 2, currentUrl: "https://example.com/" });
  assert.equal(seenSignals.length, 3);
  assert.ok(seenSignals.every((signal) => signal instanceof AbortSignal && !signal.aborted));
});

test("ambient context returns undefined when executor rejects", async () => {
  const executor: BrowserAmbientContextExecutor = {
    list: async () => {
      throw new Error("endpoint unreachable");
    },
    execute: async () => ({ ok: true, elapsedMs: 0 }),
  };
  const result = await collectBrowserAmbientContext(
    executor,
    { sessionId: "s1", workspacePath: "/w" },
    { deadlineMs: 50 },
  );
  assert.equal(result, undefined);
>>>>>>> b65bb69d (fix(desktop): 外部 CDP 不可达不再阻塞新会话（ambient 1.5s deadline + 连接失败 10s 负缓存 + abort 贯穿）)
});
