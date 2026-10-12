import {
  buildChatGPTAccountProviderId,
  CHATGPT_CODEX_BASE_URL,
  chatGPTAccountNeedsRefresh,
  mergeChatGPTRateLimitHeadersIntoUsage,
  parseChatGPTAccountProviderId,
  parseChatGPTAccessTokenExpiresAt,
  toChatGPTAccountView,
  type ChatGPTAccountRecord,
  type ChatGPTAccountView,
  type ChatGPTRequestOutcome,
  type ChatGPTUsageSnapshot,
} from "@zcode/shared";
import type { Emitter } from "@zcode/rpc";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { AccountRequestCredentialUnavailableError } from "../model-provider/accountProviderRequestAuthService.js";
import { refreshChatGPTToken, ChatGPTOAuthError } from "./chatgptOAuthClient.js";
import type { ChatGPTAccountRepository } from "./chatgptAccountRepository.js";
import type { ChatGPTIdentityResolver } from "./chatgptIdentity.js";

/**
 * ChatGPT 账号运行时：令牌刷新（官方 5min 提前量 + Permanent 失败缓存 + per-account
 * 互斥）、CLI 请求结果上报处理（错误矩阵 §7.5）、Registry 信封投影、后台定时刷新。
 */

const REFRESH_SCAN_INTERVAL_MS = 5 * 60 * 1000;

export interface ChatGPTRequestAuthMaterial {
  apiKey: string;
  headers: Record<string, string>;
}

/** transport 经 requestAuth.headers 携带的 service_tier 私有载体头；CLI 侧消费并剥离。 */
export const CHATGPT_SERVICE_TIER_HEADER = "x-mikiko-chatgpt-service-tier";

export interface ChatGPTAccountRuntime {
  /** 请求期鉴权材料：惰性刷新（5min 窗口），auth-error 抛 Unavailable。 */
  resolveRequestAuth(accountId: string): Promise<ChatGPTRequestAuthMaterial>;
  /** 手动/导入用强制刷新；Permanent 失败落库并抛错。 */
  forceRefreshAccessToken(accountId: string): Promise<ChatGPTAccountRecord>;
  /** CLI outcome 上报入口（auth-error / usage）。 */
  applyRequestOutcome(outcome: ChatGPTRequestOutcome): Promise<void>;
  /** Registry 账号信封投影（动态 account:chatgpt:{accountId} provider）。 */
  buildEnvelope(): Promise<{
    providers: Record<string, unknown>;
    states: Record<
      string,
      { availability: "available" | "unavailable"; entitled: boolean; current: boolean }
    >;
  }>;
  start(): void;
  dispose(): void;
}

export function createChatGPTAccountRuntime(dependencies: {
  repository: ChatGPTAccountRepository;
  identity: ChatGPTIdentityResolver;
  /** 与 ChatGPTAccountService 共享的账号变更事件（node.ts 注入同一实例）。 */
  accountsChangedEmitter: Emitter<ChatGPTAccountView[]>;
  logger?: ReturnType<typeof createServiceLogger>;
  /** OAuth 端点请求注入（测试用；缺省全局 fetch）。 */
  request?: typeof fetch;
}): ChatGPTAccountRuntime {
  const logger = dependencies.logger ?? createServiceLogger("chatgpt-account");
  const refreshInFlight = new Map<string, Promise<ChatGPTAccountRecord>>();
  let scanTimer: NodeJS.Timeout | null = null;

  function emitAccountsChanged(): void {
    void dependencies.repository
      .list()
      .then((records) =>
        dependencies.accountsChangedEmitter.fire(records.map(toChatGPTAccountView)),
      )
      .catch(() => {
        /* 广播失败不影响事实更新 */
      });
  }

  async function performRefresh(record: ChatGPTAccountRecord): Promise<ChatGPTAccountRecord> {
    // Permanent 失败缓存短路：同凭证快照不再打刷新接口（官方口径）。
    if (record.permanentRefreshFailure) {
      throw new ChatGPTOAuthError(
        `ChatGPT 令牌需要重新授权: ${record.permanentRefreshFailure.reason}`,
        undefined,
        record.permanentRefreshFailure.reason,
        { kind: "permanent", reason: record.permanentRefreshFailure.reason },
      );
    }
    const response = await refreshChatGPTToken({
      clientId: record.credentials.clientId,
      refreshToken: record.credentials.refreshToken,
      ...(dependencies.request ? { request: dependencies.request } : {}),
    });
    const nowIso = new Date().toISOString();
    const nextCredentials = {
      ...record.credentials,
      // 官方语义：字段非空才覆盖（refresh_token 可能不返回，支持但不强制轮换）。
      ...(response.accessToken
        ? {
            accessToken: response.accessToken,
            accessTokenExpiresAt:
              parseChatGPTAccessTokenExpiresAt(response.accessToken) ??
              (response.expiresIn != null
                ? new Date(Date.now() + response.expiresIn * 1000).toISOString()
                : record.credentials.accessTokenExpiresAt),
          }
        : {}),
      ...(response.refreshToken ? { refreshToken: response.refreshToken } : {}),
      lastRefreshAt: nowIso,
    };
    const updated = await dependencies.repository.update(record.accountId, (current) => ({
      ...current,
      credentials: nextCredentials,
      // 重新拿到有效 token 即清理历史失败缓存与异常态。
      permanentRefreshFailure: undefined,
      status: { state: "active" as const, updatedAt: Date.now() },
      updatedAt: nowIso,
    }));
    if (!updated) throw new ChatGPTOAuthError("ChatGPT 账号已不存在");
    emitAccountsChanged();
    return updated;
  }

  async function refreshAccessToken(
    accountId: string,
    options: { force?: boolean },
  ): Promise<ChatGPTAccountRecord> {
    const existing = refreshInFlight.get(accountId);
    if (existing) return existing;
    const task = (async () => {
      const record = await dependencies.repository.get(accountId);
      if (!record) throw new ChatGPTOAuthError(`ChatGPT 账号不存在: ${accountId}`);
      if (!options.force && !chatGPTAccountNeedsRefresh(record)) return record;
      try {
        return await performRefresh(record);
      } catch (error) {
        const classification =
          error instanceof ChatGPTOAuthError ? error.classification : undefined;
        if (classification?.kind === "permanent") {
          await dependencies.repository.update(accountId, (current) => ({
            ...current,
            permanentRefreshFailure: { reason: classification.reason, at: Date.now() },
            status: {
              state: "auth-error" as const,
              reason: classification.reason,
              updatedAt: Date.now(),
            },
            updatedAt: new Date().toISOString(),
          }));
          emitAccountsChanged();
        }
        throw error;
      }
    })();
    refreshInFlight.set(accountId, task);
    try {
      return await task;
    } finally {
      refreshInFlight.delete(accountId);
    }
  }

  async function setAuthError(accountId: string, reason: string): Promise<void> {
    await dependencies.repository.update(accountId, (current) => ({
      ...current,
      status: { state: "auth-error" as const, reason, updatedAt: Date.now() },
      updatedAt: new Date().toISOString(),
    }));
    emitAccountsChanged();
  }

  return {
    async resolveRequestAuth(accountId) {
      let record = await dependencies.repository.get(accountId);
      if (!record) throw new AccountRequestCredentialUnavailableError(accountId);
      if (record.permanentRefreshFailure || record.status.state === "auth-error") {
        throw new AccountRequestCredentialUnavailableError(accountId);
      }
      if (chatGPTAccountNeedsRefresh(record)) {
        record = await refreshAccessToken(accountId, { force: true });
      }
      const identityHeaders = await dependencies.identity.resolveHeaders();
      const serviceTier = await dependencies.identity.resolveServiceTier();
      return {
        apiKey: record.credentials.accessToken,
        headers: {
          ...identityHeaders,
          "chatgpt-account-id": accountId,
          ...(record.profile.isFedramp ? { "x-openai-fedramp": "true" } : {}),
          [CHATGPT_SERVICE_TIER_HEADER]: serviceTier,
        },
      };
    },

    forceRefreshAccessToken: (accountId) => refreshAccessToken(accountId, { force: true }),

    async applyRequestOutcome(outcome) {
      const accountId = parseChatGPTAccountProviderId(outcome.providerId);
      if (!accountId) return;
      if (outcome.kind === "auth-error") {
        const reason =
          outcome.errorCode?.trim() ||
          (outcome.status != null ? `http_${outcome.status}` : "auth-error");
        if (outcome.status === 401) {
          // 401：先强制刷新一次自愈（CLI 传输层已做过本地恢复重试，这里兜底竞态）；
          // 刷新仍失败（Permanent/网络+不可用）则进入 auth-error。
          try {
            await refreshAccessToken(accountId, { force: true });
            return;
          } catch (error) {
            logger.warn(undefined, "chatgpt 401 recovery refresh failed", {
              accountId,
              error: error instanceof Error ? error.message : String(error),
            });
            const record = await dependencies.repository.get(accountId);
            if (record?.permanentRefreshFailure) return; // performRefresh 已置 auth-error
          }
        }
        await setAuthError(accountId, reason);
        logger.warn(undefined, "chatgpt account auth error reported", {
          accountId,
          status: outcome.status,
          reason,
        });
        return;
      }
      // usage：合并限流头/429 体到 usage 快照（被动更新，不动账号状态）。
      await dependencies.repository.update(accountId, (current) => {
        let usage: ChatGPTUsageSnapshot | undefined = current.usage;
        if (outcome.rateLimitHeaders) {
          usage = mergeChatGPTRateLimitHeadersIntoUsage(usage, outcome.rateLimitHeaders);
        }
        if (outcome.usageLimit && usage) {
          usage = mergeUsageLimitIntoSnapshot(usage, outcome.usageLimit);
        }
        if (!usage) return null;
        return { ...current, usage, updatedAt: new Date().toISOString() };
      });
      emitAccountsChanged();
    },

    async buildEnvelope() {
      const records = await dependencies.repository.list();
      const providers: Record<string, unknown> = {};
      const states: Record<
        string,
        { availability: "available"; entitled: boolean; current: boolean }
      > = {};
      for (const record of records) {
        // auth-error 账号不发布（摘模型）；模型列表未拉到也不发布（无可执行模型）。
        if (record.status.state === "auth-error") continue;
        const slugs = record.models?.slugs ?? [];
        if (slugs.length === 0) continue;
        const providerId = buildChatGPTAccountProviderId(record.accountId);
        providers[providerId] = {
          group: "chatgpt-family",
          logo: { type: "builtin", key: "chatgpt" },
          access: { type: "chatgpt-account", accountId: record.accountId, entitled: true },
          api: { type: "openai-responses", baseUrl: CHATGPT_CODEX_BASE_URL },
          builtinModelIds: [...slugs],
        };
        // ChatGPT 多账号并存，无「当前账号」概念；current 恒 true。
        states[providerId] = { availability: "available", entitled: true, current: true };
      }
      return { providers, states };
    },

    start() {
      if (scanTimer) return;
      scanTimer = setInterval(() => {
        void refreshDueAccounts(dependencies.repository, refreshAccessToken, logger).catch(() => {
          /* 单账号失败已在内部记录 */
        });
      }, REFRESH_SCAN_INTERVAL_MS);
      scanTimer.unref?.();
    },

    dispose() {
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = null;
    },
  };
}

async function refreshDueAccounts(
  repository: ChatGPTAccountRepository,
  refreshAccessToken: (accountId: string, options: { force?: boolean }) => Promise<unknown>,
  logger: ReturnType<typeof createServiceLogger>,
): Promise<void> {
  const records = await repository.list();
  for (const record of records) {
    if (!chatGPTAccountNeedsRefresh(record)) continue;
    try {
      await refreshAccessToken(record.accountId, { force: true });
    } catch (error) {
      logger.warn(undefined, "chatgpt scheduled token refresh failed", {
        accountId: record.accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 429 usage_limit_reached 体归一进快照：窗口归属按 limitWindowMinutes 判 5h/7d。 */
function mergeUsageLimitIntoSnapshot(
  usage: ChatGPTUsageSnapshot,
  usageLimit: NonNullable<ChatGPTRequestOutcome["usageLimit"]>,
): ChatGPTUsageSnapshot {
  const windowMinutes = usageLimit.limitWindowMinutes;
  const is5h = windowMinutes == null || windowMinutes <= 360;
  const saturated = { usedPercent: 100, ...(windowMinutes != null ? { windowMinutes } : {}) };
  return {
    ...usage,
    limitReached: true,
    ...(usageLimit.resetsAt
      ? is5h
        ? { window5h: { ...usage.window5h, ...saturated, resetAt: usageLimit.resetsAt } }
        : { window7d: { ...usage.window7d, ...saturated, resetAt: usageLimit.resetsAt } }
      : {}),
  };
}
