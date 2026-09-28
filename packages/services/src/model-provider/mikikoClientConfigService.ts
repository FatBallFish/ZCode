import {
  createDynamicWorkflowClientConfig,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  type DynamicWorkflowClientConfig,
  resolveMikikoClientConfigUrl,
  type ApiClient,
} from "@zcode/shared";

/**
 * Mikiko 自建功能配置服务（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.1）。
 *
 * 数据源是 agent.mikiko.ai 的 client/configs（MIKIKO_CLIENT_CONFIG_URL 解析），
 * 与官方 client/configs 分离：官方仅保留 Zai/CodingPlan 字段，dynamicWorkflow 灰度与
 * 分享限流从这里下发。快照缓存 1h + in-flight 合并（与官方 getClientConfigs 同节奏）。
 *
 * 失败语义（spec §4.1 fail-open，review S6 统一）：网络/HTTP/解析失败与源被显式
 * disabled 一律回落 alwaysOn——「工作流」标签是既有功能入口，配置面不可用不得关闭它；
 * 仅「远端成功但未下发 dynamicWorkflow key」视为服务端明确关闭（与官方
 * resolveDynamicWorkflowClientConfig 语义一致）。本地 env 覆盖始终最高优先。
 */

const SNAPSHOT_TTL_MS = 60 * 60 * 1000;

interface MikikoClientConfigsPayload {
  readonly configs?: {
    readonly dynamicWorkflow?: unknown;
    readonly share?: { readonly publishPerMinutePerIp?: unknown };
  } | null;
}

export interface MikikoClientConfigService {
  getDynamicWorkflowClientConfig(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** 分享发布限流（次/分钟/IP）：缺失/非法/源不可用返回 null，由服务端强制兜底。 */
  getSharePublishRateLimit(options?: { readonly forceRefresh?: boolean }): Promise<number | null>;
}

export function createMikikoClientConfigService(dependencies: {
  apiClient: ApiClient;
  now?: () => number;
}): MikikoClientConfigService {
  const now = dependencies.now ?? Date.now;
  let snapshot: MikikoClientConfigsPayload | null = null;
  let snapshotExpiresAt = 0;
  let requestInFlight: Promise<MikikoClientConfigsPayload> | null = null;

  async function loadSnapshot(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<MikikoClientConfigsPayload | null> {
    const url = resolveMikikoClientConfigUrl();
    if (url === null) {
      return null;
    }
    if (!options?.forceRefresh && snapshot && snapshotExpiresAt > now()) {
      return snapshot;
    }
    if (requestInFlight) {
      return requestInFlight;
    }
    requestInFlight = (async () => {
      const response = await dependencies.apiClient.request(url, {
        method: "GET",
        timeoutMs: 15_000,
        credentials: "omit",
      });
      if (!response.ok) {
        throw new Error(`Mikiko client configs HTTP ${response.status}`);
      }
      const envelope = (await response.json()) as { data?: MikikoClientConfigsPayload | null };
      // 信封与 Worker /api/v1/client/configs 契约一致：{ code, data: { configs } }。
      if (typeof envelope !== "object" || envelope === null) {
        throw new Error("Mikiko client configs invalid envelope");
      }
      const payload: MikikoClientConfigsPayload = envelope.data ?? {};
      snapshot = payload;
      snapshotExpiresAt = now() + SNAPSHOT_TTL_MS;
      return payload;
    })();
    try {
      return await requestInFlight;
    } finally {
      requestInFlight = null;
    }
  }

  function resolveFailOpenDynamicWorkflow(): DynamicWorkflowClientConfig {
    const override = normalizeDynamicWorkflowMode(process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
    if (override) return createDynamicWorkflowClientConfig(override, "override");
    return createDynamicWorkflowClientConfig("alwaysOn", "default");
  }

  return {
    async getDynamicWorkflowClientConfig(options) {
      // 本地覆盖在任何网络动作之前裁决（与原 provider 行为一致）。
      const override = normalizeDynamicWorkflowMode(process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]);
      if (override) return createDynamicWorkflowClientConfig(override, "override");
      try {
        const payload = await loadSnapshot(options);
        if (payload === null) {
          // 自建源被显式禁用（离线/E2E）：与请求失败同语义 fail-open 回落 alwaysOn
          // （review S6 统一分叉），本地 env 覆盖仍最高优先。
          return resolveFailOpenDynamicWorkflow();
        }
        return resolveDynamicWorkflowClientConfig({
          remote: payload.configs?.dynamicWorkflow,
          env: process.env,
        });
      } catch {
        return resolveFailOpenDynamicWorkflow();
      }
    },
    async getSharePublishRateLimit(options) {
      try {
        const payload = await loadSnapshot(options);
        const limit = payload?.configs?.share?.publishPerMinutePerIp;
        return typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? limit : null;
      } catch {
        return null;
      }
    },
  };
}
