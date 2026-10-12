import {
  normalizeChatGPTUsagePayload,
  toChatGPTAccountView,
  type ChatGPTAccountRecord,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import type { ChatGPTBackendClient, ChatGPTBackendContext } from "./chatgptBackendClient.js";
import type { ChatGPTIdentityResolver } from "./chatgptIdentity.js";

/**
 * 账号信息补全：wham/accounts/check（名称/头像/plan）+ usage + reset-credits +
 * codex/models + subscriptions 到期。单接口失败不阻塞其余结果（部分成功语义）；
 * 至少一项成功即视为补全成功，全部失败抛最后一个错误。
 */

export interface ChatGPTEnrichmentOutcome {
  record: ChatGPTAccountRecord;
  errors: string[];
}

export async function enrichChatGPTAccount(
  record: ChatGPTAccountRecord,
  dependencies: {
    backendClient: ChatGPTBackendClient;
    identity: ChatGPTIdentityResolver;
    logger: ServiceLogger;
  },
): Promise<ChatGPTEnrichmentOutcome> {
  const context = await buildBackendContext(record, dependencies.identity);
  const errors: string[] = [];
  const clientVersion = await dependencies.identity.resolveModelsClientVersion();
  const [accountsResult, usageResult, creditsResult, modelsResult] = await Promise.allSettled([
    dependencies.backendClient.fetchAccounts(context),
    dependencies.backendClient.fetchUsage(context),
    dependencies.backendClient.fetchResetCredits(context),
    dependencies.backendClient.fetchModels(context, clientVersion),
  ]);

  let next: ChatGPTAccountRecord = { ...record, updatedAt: new Date().toISOString() };

  if (accountsResult.status === "fulfilled") {
    const account = accountsResult.value.find((entry) => entry.id === record.accountId);
    const fallbackAccount = account ?? accountsResult.value.find((entry) => entry.isDefault);
    if (fallbackAccount) {
      next = {
        ...next,
        ...(fallbackAccount.name ? { displayName: fallbackAccount.name } : {}),
        ...(fallbackAccount.avatarUrl ? { avatarUrl: fallbackAccount.avatarUrl } : {}),
        profile: {
          ...next.profile,
          ...(fallbackAccount.planType ? { planType: fallbackAccount.planType } : {}),
          isDefault: fallbackAccount.isDefault ?? false,
        },
      };
    }
  } else {
    errors.push(`accounts: ${String(accountsResult.reason)}`);
  }

  if (usageResult.status === "fulfilled") {
    next = { ...next, usage: normalizeChatGPTUsagePayload(usageResult.value) };
  } else {
    errors.push(`usage: ${String(usageResult.reason)}`);
  }

  if (creditsResult.status === "fulfilled" && creditsResult.value) {
    next = { ...next, resetCredits: creditsResult.value };
  } else if (creditsResult.status === "rejected") {
    errors.push(`credits: ${String(creditsResult.reason)}`);
  }

  if (modelsResult.status === "fulfilled") {
    next = {
      ...next,
      models: {
        slugs: modelsResult.value.slugs,
        ...(modelsResult.value.etag ? { etag: modelsResult.value.etag } : {}),
        updatedAt: new Date().toISOString(),
      },
    };
  } else {
    errors.push(`models: ${String(modelsResult.reason)}`);
  }

  // 订阅到期为补充口径：失败即隐藏（spec §16 裁定 2），不进 errors。
  const expiresAt = await dependencies.backendClient.fetchSubscriptionExpiresAt(context);
  if (expiresAt) {
    next = { ...next, profile: { ...next.profile, planExpiresAt: expiresAt } };
  } else {
    const { planExpiresAt: _omitted, ...profile } = next.profile;
    next = { ...next, profile };
  }

  if (errors.length >= 4) {
    throw new Error(`ChatGPT 账号信息补全全部失败: ${errors.join("; ")}`);
  }
  for (const error of errors) {
    dependencies.logger.warn(undefined, "chatgpt account enrich partial failure", {
      accountId: record.accountId,
      error,
    });
  }
  // 手动刷新成功即恢复正常展示态（auth-error 由 token/请求链路单独管理）。
  if (next.status.state === "auth-error" && !next.permanentRefreshFailure) {
    next = { ...next, status: { state: "active", updatedAt: Date.now() } };
  }
  return { record: next, errors };
}

export async function buildBackendContext(
  record: ChatGPTAccountRecord,
  identity: ChatGPTIdentityResolver,
): Promise<ChatGPTBackendContext> {
  return {
    accessToken: record.credentials.accessToken,
    accountId: record.accountId,
    identityHeaders: { ...(await identity.resolveHeaders()) },
    ...(record.profile.isFedramp ? { isFedramp: true } : {}),
  };
}

export { toChatGPTAccountView };
