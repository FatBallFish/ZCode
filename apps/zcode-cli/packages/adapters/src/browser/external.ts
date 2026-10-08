import { randomUUID, randomInt } from "node:crypto";
import type { Browser, BrowserContext } from "playwright-core";
import type {
  BrowserControlExecuteInput,
  BrowserControlListInput,
  BrowserControlPort,
  BrowserBackendDescriptor,
  BrowserCommandResult,
} from "@zcode/contracts";
import type { ManagedCdpBrowserRuntime } from "./index.js";
import { createManagedCdpDescriptor } from "./descriptor.js";
import { loadPlaywrightChromium, type PlaywrightChromiumModule } from "./executable.js";
import {
  resolveExternalEndpoint,
  parseExternalCdpOptions,
  type ExternalCdpOptions,
} from "./external-endpoint.js";
import { ExternalCdpSession } from "./external-session.js";
import { executeExternalCommand } from "./external-command.js";
import { abortError, raceWithAbort, hasSideEffects } from "./request.js";

export interface ExternalCdpRuntimeOptions extends ExternalCdpOptions {
  instanceId?: string;
  loadPlaywright?: () => Promise<PlaywrightChromiumModule>;
}
interface Pending {
  requestId?: string;
  sessionId: string;
  turnId?: string;
  controller: AbortController;
}

class ExternalCdpPort implements BrowserControlPort {
  readonly #id: string;
  readonly #sessions = new Map<string, ExternalCdpSession>();
  readonly #closing = new Set<string>();
  readonly #pending = new Set<Pending>();
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #connecting: Promise<void> | undefined;
  #identity: string | undefined;
  // 稳定实例 ID 不能复用旧 runtime generation，防止旧 wrapper 命中新连接。
  #generation = randomInt(1, 2 ** 48 - 1);
  #disposed = false;
  constructor(readonly options: ExternalCdpRuntimeOptions) {
    if (
      options.instanceId !== undefined &&
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.instanceId)
    ) {
      throw new Error("Invalid external instance ID.");
    }
    this.#id = `cdp:external:${options.instanceId ?? randomUUID()}`;
    this.#identity = parseExternalCdpOptions(
      JSON.stringify({
        endpoint: options.endpoint,
        name: options.name,
        expectedBrowserId: options.expectedBrowserId,
      }),
    ).expectedBrowserId;
  }
  async list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]> {
    await raceWithAbort(this.connect(), input.signal ?? new AbortController().signal);
    return [
      {
        ...createManagedCdpDescriptor(this.#id, this.#generation),
        name: this.options.name ?? "External Chromium",
        apiSupportOverrides: {
          ...createManagedCdpDescriptor(this.#id, this.#generation).apiSupportOverrides,
          "BrowserUser.claimTab": false,
          "Tabs.finalize": false,
          "Tab.markDeliverable": false,
          "Tab.markHandoff": false,
          "BrowserRecordingAPI.start": false,
          "BrowserRecordingAPI.status": false,
          "BrowserRecordingAPI.cancel": false,
        },
        metadata: {
          provider: "zcode-external-cdp",
          launchMode: "external",
          ...(this.options.instanceId ? { instanceId: this.options.instanceId } : {}),
          browserIdentity: this.#identity!,
        },
      },
    ];
  }
  async execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult> {
    const start = Date.now();
    if (
      this.#disposed ||
      !this.#browser?.isConnected() ||
      input.browserId !== this.#id ||
      input.browserGeneration !== this.#generation
    ) {
      return {
        ok: false,
        elapsedMs: 0,
        error: {
          code: "backend_unavailable",
          message: "External CDP connection is unavailable or stale; discover again explicitly.",
        },
      };
    }
    if (input.command.method === "cancelRequest") {
      for (const request of this.#pending) {
        if (request.sessionId === input.sessionId && request.requestId === input.command.requestId)
          request.controller.abort();
      }
      return { ok: true, elapsedMs: Date.now() - start };
    }
    if (input.command.method === "closeSession") {
      await this.closeSession(input);
      return { ok: true, elapsedMs: Date.now() - start };
    }
    if (input.command.method === "turnEnded") {
      await this.turnEnded(input);
      return { ok: true, elapsedMs: Date.now() - start };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const pending = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      controller,
    };
    this.#pending.add(pending);
    let dispatched = false;
    try {
      if (controller.signal.aborted) throw abortError();
      if (this.#closing.has(input.sessionId)) throw new Error("External CDP session is closing.");
      let session = this.#sessions.get(input.sessionId);
      if (!session) {
        session = new ExternalCdpSession(this.#context!);
        this.#sessions.set(input.sessionId, session);
      }
      dispatched = true;
      const result = await raceWithAbort(
        executeExternalCommand(session, input.command),
        controller.signal,
      );
      return {
        ...result,
        elapsedMs: Date.now() - start,
        meta: {
          browserUse: true,
          backendType: "cdp",
          browserId: this.#id,
          browserGeneration: this.#generation,
          openTabIds: session.tabIds,
        },
      };
    } catch {
      return {
        ok: false,
        elapsedMs: Date.now() - start,
        error: {
          code: controller.signal.aborted ? "cancelled" : "execution_error",
          message:
            "External CDP command failed or was cancelled; no automatic replay was performed.",
          ...(dispatched && hasSideEffects(input.command)
            ? { sideEffect: "uncertain" as const }
            : {}),
        },
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.#pending.delete(pending);
    }
  }
  async turnEnded(input: BrowserControlListInput): Promise<void> {
    for (const request of this.#pending) {
      if (request.sessionId === input.sessionId && request.turnId === input.turnId)
        request.controller.abort();
    }
  }
  async closeSession(input: BrowserControlListInput): Promise<void> {
    this.#closing.add(input.sessionId);
    for (const request of this.#pending)
      if (request.sessionId === input.sessionId) request.controller.abort();
    const session = this.#sessions.get(input.sessionId);
    await session?.close();
    if (this.#sessions.get(input.sessionId) === session) this.#sessions.delete(input.sessionId);
  }
  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const request of this.#pending) request.controller.abort();
    const cleanup = await Promise.allSettled(
      [...this.#sessions.values()].map((session) => session.close()),
    );
    this.#sessions.clear();
    await this.#connecting?.catch(() => undefined);
    const browser = this.#browser;
    this.#browser = undefined;
    this.#context = undefined;
    // connectOverCDP 的 Browser.close 只断开 Playwright client；不向远端发送 Browser.close。
    if (browser?.isConnected()) await browser.close();
    const failed = cleanup.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      throw new Error("External CDP owned-page cleanup failed.", { cause: failed.reason });
  }
  private async connect(): Promise<void> {
    if (this.#disposed) throw new Error("External CDP runtime is closed.");
    if (this.#browser?.isConnected()) return;
    this.#connecting ??= (async () => {
      const target = await resolveExternalEndpoint(this.options.endpoint, this.#identity);
      this.#identity ??= target.browserId;
      const playwright = await (this.options.loadPlaywright ?? loadPlaywrightChromium)();
      const browser = await playwright.chromium.connectOverCDP(target.websocket, {
        timeout: 10_000,
      });
      if (this.#disposed) {
        await browser.close();
        throw new Error("External CDP runtime closed during attach.");
      }
      const contexts = browser.contexts();
      if (contexts.length !== 1) {
        await browser.close();
        throw new Error("External CDP requires one unambiguous persistent context.");
      }
      this.#browser = browser;
      this.#context = contexts[0];
      browser.on("disconnected", () => {
        if (this.#browser !== browser) return;
        this.#browser = undefined;
        this.#context = undefined;
        this.#generation += 1;
        for (const request of this.#pending) request.controller.abort();
        for (const session of this.#sessions.values()) session.invalidate();
        this.#sessions.clear();
      });
    })().finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
  }
}

export function createExternalCdpBrowserRuntime(
  options: ExternalCdpRuntimeOptions,
): ManagedCdpBrowserRuntime {
  const port = new ExternalCdpPort(options);
  return { browserControlPort: port, close: () => port.close() };
}

export {
  parseExternalCdpOptions,
  validateExternalEndpoint,
  resolveExternalEndpoint,
} from "./external-endpoint.js";
export type { ExternalCdpOptions } from "./external-endpoint.js";
