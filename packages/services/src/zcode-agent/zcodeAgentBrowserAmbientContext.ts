import { randomUUID } from "node:crypto";
import {
  browserCommandResultSchema,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  type ZCodeBrowserAmbientContext,
} from "@zcode/shared";

export interface BrowserAmbientContextExecutor {
  list(input: {
    requestId: string;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
    signal?: AbortSignal;
  }): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
    command: BrowserCommand;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; [key: string]: unknown }>;
}

interface BrowserAmbientContextTarget {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: BrowserClientMode;
}

function sanitizeAmbientUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!["about:", "http:", "https:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    const value = url.toString();
    return value.length <= 4096 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 只读收集 provider ambient state。失败时返回 undefined，不能让浏览器 UI 状态阻断真实 prompt。
 *
 * 客户反馈（Windows，2026-10-11）：外部 CDP 端点不可用时，新会话首条消息在本函数里
 * 串行等待 external connect 的 10s+10s 握手超时，且每条消息重复发生，表现为新建会话
 * 长时间卡住。ambient 只是尽力而为的上下文补充，因此这里加整体 deadline：到期即放弃
 * （返回 undefined），并把 AbortSignal 下发给 executor，让下游（external CDP 的
 * raceWithAbort）立即停止等待，而不是留一个挂满超时的连接尝试。
 */
const AMBIENT_CONTEXT_DEADLINE_MS = 1_500;

export interface BrowserAmbientContextOptions {
  deadlineMs?: number;
}

function withAmbientDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Browser ambient context deadline exceeded."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    run(controller.signal)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      });
  });
}

export async function collectBrowserAmbientContext(
  executor: BrowserAmbientContextExecutor | undefined,
  target: BrowserAmbientContextTarget,
  options: BrowserAmbientContextOptions = {},
): Promise<ZCodeBrowserAmbientContext | undefined> {
  if (!executor) return undefined;
  try {
    return await withAmbientDeadline(
      (signal) => collectFromExecutor(executor, target, signal),
      options.deadlineMs ?? AMBIENT_CONTEXT_DEADLINE_MS,
    );
  } catch {
    return undefined;
  }
}

async function collectFromExecutor(
  executor: BrowserAmbientContextExecutor,
  target: BrowserAmbientContextTarget,
  signal: AbortSignal,
): Promise<ZCodeBrowserAmbientContext | undefined> {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const clientMode = target.clientMode ?? "desktop-continuous";
  const common = {
    sessionId: target.sessionId,
    workspaceKey,
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    clientMode,
    sessionContext: "live" as const,
    signal,
  };

  const descriptors = await executor.list({
    requestId: randomUUID(),
    ...common,
  });
  const browser = descriptors.find((candidate) => candidate.type === "iab");
  if (!browser) return undefined;

  const [controlledOutcome, userOutcome] = await Promise.allSettled([
    executor.execute({
      requestId: randomUUID(),
      browserId: browser.id,
      browserGeneration: browser.generation,
      ...common,
      command: { method: "list" },
    }),
    executor.execute({
      requestId: randomUUID(),
      browserId: browser.id,
      browserGeneration: browser.generation,
      ...common,
      command: { method: "listUserTabs" },
    }),
  ]);
  const controlled =
    controlledOutcome.status === "fulfilled"
      ? browserCommandResultSchema.safeParse(controlledOutcome.value)
      : undefined;
  const users =
    userOutcome.status === "fulfilled"
      ? browserCommandResultSchema.safeParse(userOutcome.value)
      : undefined;
  const controlledTabs =
    controlled?.success && controlled.data.ok ? (controlled.data.tabs ?? []) : [];
  const userTabs = users?.success && users.data.ok ? (users.data.userTabs ?? []) : [];
  const tabIds = new Set([
    ...controlledTabs.map((tab) => tab.tabId),
    ...userTabs.map((tab) => tab.id),
  ]);
  if (tabIds.size === 0) return undefined;

  // 显式 finalize 后页面属于 user tabs；漏 finalize 的 handoff 仍属于 controlled tabs。
  // 两类都必须进入 ambient state，否则下一轮会把空 tabs.list() 误判为浏览器断线。
  const currentControlled = controlledTabs.find((tab) => tab.active);
  const currentUrl = sanitizeAmbientUrl(
    currentControlled?.url ?? userTabs[0]?.url ?? controlledTabs.at(-1)?.url,
  );
  return {
    tabCount: tabIds.size,
    ...(currentUrl ? { currentUrl } : {}),
  };
}
