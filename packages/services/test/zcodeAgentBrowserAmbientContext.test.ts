import { describe, expect, it, vi } from "vitest";

import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "../src/zcode-agent/zcodeAgentBrowserAmbientContext.js";

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
});

describe("collectBrowserAmbientContext deadline", () => {
  it("gives up at deadline instead of blocking prompt forwarding", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const executor = {
      list: async (input: { signal?: AbortSignal }) => {
        signals.push(input.signal);
        return new Promise<never[]>(() => {});
      },
      execute: async () => ({ ok: true, elapsedMs: 0 }),
    };
    const startedAt = Date.now();
    const result = await collectBrowserAmbientContext(
      executor,
      { sessionId: "s1", workspacePath: "/w" },
      { deadlineMs: 50 },
    );
    expect(result).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(signals.length).toBe(1);
    expect(signals[0] instanceof AbortSignal).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("returns undefined when executor rejects", async () => {
    const executor = {
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
    expect(result).toBeUndefined();
  });
});
