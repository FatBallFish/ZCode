import { randomUUID } from "node:crypto";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { Emitter, type Event } from "@zcode/rpc";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  buildChatGPTAuthorizeUrl,
  generateChatGPTPkce,
  generateChatGPTState,
  parseChatGPTIdTokenClaims,
  parseChatGPTAccessTokenExpiresAt,
  parseSub2ApiAccountExport,
  toChatGPTAccountView,
  type ChatGPTAccountRecord,
  type ChatGPTAccountView,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  ChatGPTAuthorizationResult,
  ChatGPTAuthorizationSession,
  ChatGPTImportResult,
  IChatGPTAccountService,
} from "./chatgptAccount.js";
import { ChatGPTBackendError, type ChatGPTBackendClient } from "./chatgptBackendClient.js";
import { buildBackendContext, enrichChatGPTAccount } from "./chatgptAccountEnrichment.js";
import type { ChatGPTAccountRepository } from "./chatgptAccountRepository.js";
import type { ChatGPTAccountRuntime } from "./chatgptAccountRuntime.js";
import {
  CHATGPT_CALLBACK_PORT_IN_USE,
  ChatGPTOAuthError,
  exchangeChatGPTCode,
  refreshChatGPTToken,
  revokeChatGPTToken,
  startChatGPTCallbackListener,
  type ChatGPTCallbackListener,
} from "./chatgptOAuthClient.js";
import type { ChatGPTIdentityResolver } from "./chatgptIdentity.js";

/**
 * ChatGPT 账号 RPC 服务实现：授权流程（PKCE + loopback 1455）、sub2api 导入、
 * 信息刷新、额度重置、退出登录。账号事实唯一 owner 是 repository（加密存储），
 * 本服务编排并广播脱敏视图。
 */

export interface ChatGPTAccountServiceOptions {
  repository: ChatGPTAccountRepository;
  backendClient: ChatGPTBackendClient;
  identity: ChatGPTIdentityResolver;
  runtime: ChatGPTAccountRuntime;
  /** 与 ChatGPTAccountRuntime 共享的账号变更事件（node.ts 注入同一实例）。 */
  accountsChangedEmitter?: Emitter<ChatGPTAccountView[]>;
  logger?: ReturnType<typeof createServiceLogger>;
  readFile?: (path: string) => Promise<string>;
  /** OAuth 端点请求出口：生产为 node.ts 注入的 host API 网络 transport（httpProxy/CA 生效）；测试可 mock。 */
  request?: typeof fetch;
  /** 回调监听端口注入（测试用；生产固定 1455）。 */
  callbackPort?: number;
}

interface PendingAuthorization {
  sessionId: string;
  state: string;
  codeVerifier: string;
  listener: ChatGPTCallbackListener;
}

export function createChatGPTAccountService(
  options: ChatGPTAccountServiceOptions,
): IChatGPTAccountService {
  const logger = options.logger ?? createServiceLogger("chatgpt-account");
  const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  const accountsChangedEmitter =
    options.accountsChangedEmitter ?? new Emitter<ChatGPTAccountView[]>();
  const authorizationCompletedEmitter = new Emitter<ChatGPTAuthorizationResult>();
  const authorizationFailedEmitter = new Emitter<{ message: string }>();
  let pendingAuthorization: PendingAuthorization | null = null;

  async function listViews(): Promise<ChatGPTAccountView[]> {
    return (await options.repository.list()).map(toChatGPTAccountView);
  }

  async function emitAccountsChanged(): Promise<void> {
    accountsChangedEmitter.fire(await listViews());
  }

  async function requireRecord(accountId: string): Promise<ChatGPTAccountRecord> {
    const record = await options.repository.get(accountId);
    if (!record) throw new ChatGPTOAuthError(`ChatGPT 账号不存在: ${accountId}`);
    return record;
  }

  async function persistEnriched(record: ChatGPTAccountRecord): Promise<ChatGPTAccountView> {
    const outcome = await enrichChatGPTAccount(record, {
      backendClient: options.backendClient,
      identity: options.identity,
      logger,
    });
    const updated = await options.repository.update(record.accountId, (current) => ({
      ...current,
      // enrich 基于读取时的 record，落库时保留期间可能的 token 更新。
      displayName: outcome.record.displayName ?? current.displayName,
      avatarUrl: outcome.record.avatarUrl ?? current.avatarUrl,
      profile: outcome.record.profile,
      usage: outcome.record.usage ?? current.usage,
      resetCredits: outcome.record.resetCredits ?? current.resetCredits,
      models: outcome.record.models ?? current.models,
      status: outcome.record.status.state === "active" ? outcome.record.status : current.status,
      updatedAt: outcome.record.updatedAt,
    }));
    await emitAccountsChanged();
    return toChatGPTAccountView(updated ?? outcome.record);
  }

  async function completeAuthorization(code: string, session: PendingAuthorization): Promise<void> {
    const tokens = await exchangeChatGPTCode({
      code,
      codeVerifier: session.codeVerifier,
      ...(options.request ? { request: options.request } : {}),
    });
    const claims = tokens.idToken
      ? parseChatGPTIdTokenClaims(tokens.idToken)
      : parseChatGPTIdTokenClaims(tokens.accessToken);
    if (!claims?.accountId) {
      throw new ChatGPTOAuthError("授权结果缺少 chatgpt_account_id，请重试");
    }
    const existing = await options.repository.get(claims.accountId);
    const nowIso = new Date().toISOString();
    const record: ChatGPTAccountRecord = {
      accountId: claims.accountId,
      email: claims.email ?? existing?.email ?? "",
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      credentials: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        lastRefreshAt: nowIso,
        clientId: CHATGPT_OAUTH_CLIENT_ID,
      },
      profile: {
        ...(existing?.profile ?? {}),
        ...(claims.planType ? { planType: claims.planType } : {}),
        isFedramp: claims.isFedramp,
      },
      status: { state: "active", updatedAt: Date.now() },
    };
    await options.repository.upsert(record);
    try {
      await persistEnriched(record);
    } catch (error) {
      logger.warn(undefined, "chatgpt authorization enrich failed", {
        accountId: record.accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    authorizationCompletedEmitter.fire({ accountId: record.accountId, email: record.email });
  }

  return {
    async getAccounts() {
      return listViews();
    },

    async startAuthorization(): Promise<ChatGPTAuthorizationSession> {
      await this.cancelAuthorization();
      const state = await generateChatGPTState();
      const { codeVerifier, codeChallenge } = await generateChatGPTPkce();
      const sessionId = randomUUID();
      const session: PendingAuthorization = {
        sessionId,
        state,
        codeVerifier,
        listener: null as unknown as ChatGPTCallbackListener,
      };
      // 端口被占用（如 Codex CLI 正在登录）→ 中断授权（用户裁定，无 fallback 端口）。
      session.listener = await startChatGPTCallbackListener({
        expectedState: state,
        onCode: (code) => completeAuthorization(code, session),
        ...(options.callbackPort != null ? { port: options.callbackPort } : {}),
      });
      pendingAuthorization = session;
      void session.listener.done
        .then(() => {
          if (pendingAuthorization === session) pendingAuthorization = null;
        })
        .catch((error: unknown) => {
          if (pendingAuthorization !== session) return;
          pendingAuthorization = null;
          // 回调成功页在 code→token 兑换前就已返回浏览器，「已登录」≠账号已添加；
          // 兑换/写库失败只经本事件透出。此前这里不落任何日志，客户侧「浏览器成功、
          // 客户端失败」无从排查（2026-10-17 案例），补 warn（只记错误元信息，不含 token）。
          logger.warn(undefined, "chatgpt authorization failed", {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            ...(error instanceof ChatGPTOAuthError && error.status != null
              ? { status: error.status }
              : {}),
            ...(error instanceof ChatGPTOAuthError && error.errorCode
              ? { errorCode: error.errorCode }
              : {}),
          });
          const message =
            error instanceof ChatGPTOAuthError && error.message === CHATGPT_CALLBACK_PORT_IN_USE
              ? "授权回调端口 1455 被占用，可能是 Codex CLI 正在运行或登录中，请关闭后重试"
              : error instanceof ChatGPTOAuthError && error.classification?.reason === "network"
                ? "网络错误：无法连接 ChatGPT 授权服务（auth.openai.com），请检查网络，或在「设置 → 常规 → HTTP 代理」配置代理后重试"
                : error instanceof ChatGPTOAuthError
                  ? error.message
                  : "授权失败，请重试";
          authorizationFailedEmitter.fire({ message });
        });
      return {
        sessionId,
        authUrl: buildChatGPTAuthorizeUrl({ state, codeChallenge }),
      };
    },

    async cancelAuthorization() {
      const session = pendingAuthorization;
      pendingAuthorization = null;
      // close 触发 done reject → 上面的 catch 不再 fire（已置空 pending）。
      session?.listener.close();
    },

    async refreshAccountInfo(accountId: string) {
      const record = await requireRecord(accountId);
      return persistEnriched(record);
    },

    async refreshAllAccountUsage() {
      // auth-error 账号 enrich 必然再失败（且可能触发 Permanent 缓存误判），跳过。
      const records = (await options.repository.list()).filter(
        (record) => record.status.state !== "auth-error",
      );
      await Promise.allSettled(records.map((record) => persistEnriched(record)));
    },

    async refreshToken(accountId: string) {
      await requireRecord(accountId);
      await options.runtime.forceRefreshAccessToken(accountId);
      return toChatGPTAccountView(await requireRecord(accountId));
    },

    async resetQuota(accountId: string) {
      const record = await requireRecord(accountId);
      const context = await buildBackendContext(record, options.identity);
      // 幂等键：单次用户操作固定；上游重复消费返回同一结果。
      const redeemRequestId = randomUUID();
      await options.backendClient.consumeResetCredit(context, redeemRequestId);
      return persistEnriched(await requireRecord(accountId));
    },

    async logoutAccount(accountId: string) {
      const record = await requireRecord(accountId);
      // best-effort revoke：失败不阻塞本地登出（官方口径）。
      await revokeChatGPTToken({
        clientId: record.credentials.clientId,
        refreshToken: record.credentials.refreshToken,
        ...(options.request ? { request: options.request } : {}),
      }).catch((error: unknown) => {
        logger.warn(undefined, "chatgpt revoke failed", {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await options.repository.delete(accountId);
      await emitAccountsChanged();
    },

    async importSub2ApiAccounts(filePath: string): Promise<ChatGPTImportResult> {
      const raw = await readFile(filePath);
      if (raw.length > 2 * 1024 * 1024) {
        throw new ChatGPTOAuthError("导出文件过大（上限 2MB）");
      }
      const parsed = parseSub2ApiAccountExport(JSON.parse(raw));
      const imported: ChatGPTImportResult["imported"] = [];
      for (const account of parsed.accounts) {
        const existing = await options.repository.get(account.accountId);
        const nowIso = new Date().toISOString();
        let accessToken = account.accessToken;
        let accessTokenExpiresAt = account.accessTokenExpiresAt;
        if (!accessToken) {
          // 无 access_token：先用 refresh_token 换新（失败则该条不导入）。
          try {
            const refreshed = await refreshChatGPTToken({
              clientId: account.clientId,
              refreshToken: account.refreshToken,
              ...(options.request ? { request: options.request } : {}),
            });
            if (!refreshed.accessToken) throw new ChatGPTOAuthError("刷新未返回 access_token");
            accessToken = refreshed.accessToken;
            accessTokenExpiresAt =
              parseChatGPTAccessTokenExpiresAt(accessToken) ??
              (refreshed.expiresIn != null
                ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
                : undefined);
          } catch (error) {
            parsed.skipped.push({
              email: account.email || undefined,
              reason: `token-refresh-failed:${
                error instanceof ChatGPTBackendError || error instanceof ChatGPTOAuthError
                  ? error.message
                  : "unknown"
              }`,
            });
            continue;
          }
        }
        const record: ChatGPTAccountRecord = {
          accountId: account.accountId,
          email: account.email || existing?.email || "",
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
          credentials: {
            accessToken: accessToken!,
            refreshToken: account.refreshToken,
            ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
            lastRefreshAt: nowIso,
            clientId: account.clientId,
          },
          profile: {
            ...(existing?.profile ?? {}),
            ...(account.planType ? { planType: account.planType } : {}),
            isFedramp: existing?.profile.isFedramp ?? false,
          },
          status: { state: "active", updatedAt: Date.now() },
        };
        await options.repository.upsert(record);
        let enrichError: string | undefined;
        try {
          await persistEnriched(record);
        } catch (error) {
          enrichError = error instanceof Error ? error.message : String(error);
        }
        imported.push({
          accountId: account.accountId,
          email: record.email,
          state: existing ? "updated" : "created",
          ...(enrichError ? { enrichError } : {}),
        });
      }
      await emitAccountsChanged();
      return { imported, skipped: parsed.skipped };
    },

    onDidChangeAccounts: accountsChangedEmitter.event as Event<ChatGPTAccountView[]>,
    onAuthorizationCompleted:
      authorizationCompletedEmitter.event as Event<ChatGPTAuthorizationResult>,
    onAuthorizationFailed: authorizationFailedEmitter.event as Event<{ message: string }>,
  };
}
