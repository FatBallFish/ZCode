import {
  CHATGPT_BACKEND_ORIGIN,
  CHATGPT_IMAGE_MODEL,
  type ChatGPTResetCredits,
} from "@zcode/shared";
import { ChatGPTCloudflareCookieJar } from "./chatgptCloudflareCookieJar.js";

/**
 * ChatGPT backend-api（wham / codex）只读客户端：账号检查、订阅到期、usage、
 * 重置次数、模型清单、额度重置消费、生图/编辑。身份头由调用方组装注入
 * （host 请求期统一走 buildCodexIdentityHeaders）。
 */

export interface ChatGPTBackendContext {
  accessToken: string;
  accountId: string;
  /** §7.2 身份头（originator/user-agent/version 等，不含 authorization）。 */
  identityHeaders: Record<string, string>;
  isFedramp?: boolean;
}

export interface ChatGPTBackendAccount {
  id: string;
  planType?: string;
  name?: string;
  avatarUrl?: string;
  isDefault?: boolean;
}

export interface ChatGPTModelsManifest {
  slugs: string[];
  etag?: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MODELS_TIMEOUT_MS = 5_000;

export class ChatGPTBackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "ChatGPTBackendError";
  }
}

export interface ChatGPTBackendClient {
  fetchAccounts(context: ChatGPTBackendContext): Promise<ChatGPTBackendAccount[]>;
  fetchSubscriptionExpiresAt(context: ChatGPTBackendContext): Promise<string | null>;
  fetchUsage(context: ChatGPTBackendContext): Promise<unknown>;
  fetchResetCredits(context: ChatGPTBackendContext): Promise<ChatGPTResetCredits | null>;
  consumeResetCredit(
    context: ChatGPTBackendContext,
    redeemRequestId: string,
  ): Promise<{ consumed: boolean }>;
  fetchModels(
    context: ChatGPTBackendContext,
    clientVersion: string,
  ): Promise<ChatGPTModelsManifest>;
  generateImage(
    context: ChatGPTBackendContext,
    input: { prompt: string; size?: string; quality?: string; background?: string; n?: number },
  ): Promise<Array<{ b64Json: string }>>;
  editImage(
    context: ChatGPTBackendContext,
    input: {
      prompt: string;
      images: string[];
      size?: string;
      quality?: string;
      background?: string;
    },
  ): Promise<Array<{ b64Json: string }>>;
}

export function createChatGPTBackendClient(options?: {
  request?: typeof fetch;
  cookieJar?: ChatGPTCloudflareCookieJar;
}): ChatGPTBackendClient {
  const request = options?.request ?? fetch;
  const cookieJar = options?.cookieJar ?? new ChatGPTCloudflareCookieJar();

  async function backendFetch(
    context: ChatGPTBackendContext,
    path: string,
    init: { method: "GET" | "POST"; body?: string; accept?: string; timeoutMs?: number },
  ): Promise<Response> {
    const url = `${CHATGPT_BACKEND_ORIGIN}${path}`;
    const cookie = cookieJar.cookieHeader(new URL(url).hostname);
    const response = await request(url, {
      method: init.method,
      headers: {
        ...context.identityHeaders,
        authorization: `Bearer ${context.accessToken}`,
        "chatgpt-account-id": context.accountId,
        accept: init.accept ?? "application/json",
        ...(context.isFedramp ? { "x-openai-fedramp": "true" } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const setCookies =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    cookieJar.store(new URL(url).hostname, setCookies);
    return response;
  }

  async function readJson(response: Response, path: string): Promise<unknown> {
    if (!response.ok) {
      let errorCode: string | undefined;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        errorCode = body?.error?.code ?? undefined;
      } catch {
        /* HTML 错误页（如 Cloudflare 拦截）无 code */
      }
      throw new ChatGPTBackendError(
        `ChatGPT backend ${path} HTTP ${response.status}`,
        response.status,
        errorCode,
      );
    }
    return response.json();
  }

  return {
    async fetchAccounts(context) {
      const payload = await readJson(
        await backendFetch(context, "/wham/accounts/check", { method: "GET" }),
        "/wham/accounts/check",
      );
      const rawAccounts = (payload as { accounts?: Record<string, unknown> }).accounts ?? {};
      const accounts: ChatGPTBackendAccount[] = [];
      for (const entry of Object.values(rawAccounts)) {
        const account = (entry as { account?: Record<string, unknown> })?.account;
        if (!account || typeof account.account_id !== "string") continue;
        const planType = firstString(account.plan_type);
        accounts.push({
          id: account.account_id,
          ...(planType ? { planType } : {}),
          ...optionalString("name", account.name),
          ...optionalString(
            "avatarUrl",
            (account as { profile_picture_url?: unknown }).profile_picture_url,
          ),
          ...(account.is_default === true ? { isDefault: true } : {}),
        });
      }
      return accounts;
    },

    async fetchSubscriptionExpiresAt(context) {
      // sub2api 验证过的补充口径（官方不调用）；失败即隐藏，不重试（spec §16 裁定 2）。
      try {
        const payload = await readJson(
          await backendFetch(
            context,
            `/subscriptions?account_id=${encodeURIComponent(context.accountId)}`,
            { method: "GET" },
          ),
          "/subscriptions",
        );
        const activeUntil = (payload as { active_until?: unknown }).active_until;
        if (typeof activeUntil === "string" && activeUntil.trim()) {
          const parsed = Date.parse(activeUntil);
          if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
        }
        return null;
      } catch {
        return null;
      }
    },

    async fetchUsage(context) {
      return readJson(await backendFetch(context, "/wham/usage", { method: "GET" }), "/wham/usage");
    },

    async fetchResetCredits(context) {
      const payload = await readJson(
        await backendFetch(context, "/wham/rate-limit-reset-credits", { method: "GET" }),
        "/wham/rate-limit-reset-credits",
      );
      return parseResetCreditsPayload(payload);
    },

    async consumeResetCredit(context, redeemRequestId) {
      // 幂等键由调用方保证：重试复用同一 uuid（官方口径）。
      const payload = await readJson(
        await backendFetch(context, "/wham/rate-limit-reset-credits/consume", {
          method: "POST",
          body: JSON.stringify({ redeem_request_id: redeemRequestId }),
        }),
        "/wham/rate-limit-reset-credits/consume",
      );
      return { consumed: (payload as { credit?: unknown })?.credit != null };
    },

    async fetchModels(context, clientVersion) {
      const path = `/codex/models?client_version=${encodeURIComponent(clientVersion)}`;
      const response = await backendFetch(context, path, {
        method: "GET",
        timeoutMs: MODELS_TIMEOUT_MS,
      });
      if (!response.ok) {
        throw new ChatGPTBackendError(`ChatGPT models HTTP ${response.status}`, response.status);
      }
      const etag = response.headers.get("etag") ?? undefined;
      const payload = (await response.json()) as {
        models?: Array<{ slug?: unknown; visibility?: unknown }>;
      };
      // visibility=hide 的模型（内部/实验 slug）不进入可投影列表（官方 manifest 口径）。
      const slugs = (payload.models ?? [])
        .filter((model) => model?.visibility !== "hide")
        .map((model) => (typeof model?.slug === "string" ? model.slug.trim() : ""))
        .filter((slug) => slug.length > 0);
      return { slugs, ...(etag ? { etag } : {}) };
    },

    async generateImage(context, input) {
      return requestImages(context, "/codex/images/generations", {
        prompt: input.prompt,
        model: CHATGPT_IMAGE_MODEL,
        ...(input.size ? { size: input.size } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.background ? { background: input.background } : {}),
        ...(input.n != null ? { n: input.n } : {}),
      });
    },

    async editImage(context, input) {
      return requestImages(context, "/codex/images/edits", {
        prompt: input.prompt,
        model: CHATGPT_IMAGE_MODEL,
        images: input.images,
        ...(input.size ? { size: input.size } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.background ? { background: input.background } : {}),
      });
    },
  };

  async function requestImages(
    context: ChatGPTBackendContext,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Array<{ b64Json: string }>> {
    // 生图走独立 JSON 端点（官方 ext/image-generation）；带 turn-id 头便于上游诊断。
    const payload = await readJson(
      await backendFetch(context, path, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      path,
    );
    const data = (payload as { data?: Array<{ b64_json?: unknown }> }).data ?? [];
    return data
      .map((item) => (typeof item?.b64_json === "string" ? { b64Json: item.b64_json } : null))
      .filter((item): item is { b64Json: string } => item != null);
  }
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(key: string, value: unknown): Record<string, string> {
  const normalized = firstString(value);
  return normalized ? { [key]: normalized } : {};
}

/** 重置次数解析：兼容裸数组与 {available_count, credits[]} 两种形态（sub2api 口径）。 */
function parseResetCreditsPayload(payload: unknown): ChatGPTResetCredits | null {
  if (Array.isArray(payload)) {
    const credits = payload.filter(isAvailableResetCredit);
    return { availableCount: credits.length, credits };
  }
  const raw = (payload ?? {}) as {
    available_count?: unknown;
    credits?: unknown;
  };
  const list = Array.isArray(raw.credits) ? raw.credits : [];
  const credits = list.filter(isAvailableResetCredit).map(toResetCredit);
  const availableCount =
    typeof raw.available_count === "number" && Number.isFinite(raw.available_count)
      ? Math.max(0, Math.floor(raw.available_count))
      : credits.length;
  return { availableCount, credits };
}

function isAvailableResetCredit(entry: unknown): boolean {
  const credit = entry as { reset_type?: unknown; status?: unknown };
  return (
    (credit?.reset_type == null || credit.reset_type === "codex_rate_limits") &&
    (credit?.status == null || credit.status === "available")
  );
}

function toResetCredit(entry: unknown): { id?: string; expiresAt?: string; status?: string } {
  const credit = (entry ?? {}) as { id?: unknown; expires_at?: unknown; status?: unknown };
  const expiresAt = firstString(credit.expires_at);
  const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
  return {
    ...optionalString("id", credit.id),
    ...(Number.isFinite(parsed) ? { expiresAt: new Date(parsed).toISOString() } : {}),
    ...optionalString("status", credit.status),
  };
}
