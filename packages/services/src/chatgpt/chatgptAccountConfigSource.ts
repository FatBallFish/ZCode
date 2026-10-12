import type { Event } from "@zcode/rpc";
import {
  parseAccountProviderConfigMap,
  ProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderServiceRefreshErrorEvent,
} from "@zcode/provider";
import type { ChatGPTAccountRuntime } from "./chatgptAccountRuntime.js";

/**
 * ChatGPT 账号信封合并源：包装既有 accountProviderConfigSource（智谱域），
 * 把动态 account:chatgpt:{accountId} provider 合并进同一份 Account 快照。
 * 双向变更（base 变化 / ChatGPT 账号变化）都触发 onDidChange，驱动 Registry 刷新
 * 与 providerUpdateAccountConfig 推送（复用既有链路，不另建第二条写入路径）。
 */

/** host 侧账号源的结构契约（AccountProviderService 满足此形状）。 */
export interface AccountProviderSourceLike {
  read(): Promise<AccountProviderConfigSnapshot>;
  refresh(reason?: string): Promise<AccountProviderConfigSnapshot>;
  onDidChange(listener: (reason: string) => void): () => void;
  onDidRefreshError(listener: (event: AccountProviderServiceRefreshErrorEvent) => void): () => void;
  dispose(): void;
}

export function createChatGPTAccountConfigSource(options: {
  base: AccountProviderSourceLike;
  runtime: ChatGPTAccountRuntime;
  onChatGPTAccountsChanged: Event<unknown>;
}): AccountProviderSourceLike {
  let chatgptRevision = 0;
  const listeners = new Set<(reason: string) => void>();

  function notify(reason: string): void {
    chatgptRevision += 1;
    for (const listener of listeners) listener(reason);
  }

  async function mergeSnapshot(
    base: AccountProviderConfigSnapshot,
  ): Promise<AccountProviderConfigSnapshot> {
    const envelope = await options.runtime.buildEnvelope();
    const chatgptProviders = parseAccountProviderConfigMap(envelope.providers);
    const providers = new ProviderConfigMap([
      ...base.providers.entries(),
      ...chatgptProviders.entries(),
    ]);
    return Object.freeze({
      // chatgpt 部分变化也必须 bump revision，否则 CLI 侧 replace() 去重会丢弃更新。
      revision: `${base.revision}:cg${chatgptRevision}`,
      basedOnZCodeBuiltinRevision: base.basedOnZCodeBuiltinRevision,
      providers,
      states: { ...(base.states ?? {}), ...envelope.states },
    });
  }

  return {
    async read() {
      return mergeSnapshot(await options.base.read());
    },
    async refresh(reason) {
      await options.base.refresh(reason);
      return mergeSnapshot(await options.base.read());
    },
    onDidChange(listener) {
      listeners.add(listener);
      const disposeBase = options.base.onDidChange(listener);
      const disposeChatGPT = options.onChatGPTAccountsChanged(() => notify("chatgpt-accounts"));
      return () => {
        listeners.delete(listener);
        disposeBase();
        disposeChatGPT.dispose();
      };
    },
    onDidRefreshError(listener) {
      return options.base.onDidRefreshError(listener);
    },
    dispose() {
      options.base.dispose();
    },
  };
}
