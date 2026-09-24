/* eslint-disable max-lines -- sub2api 服务层集中管理站点凭据、余额/订阅拉取与模型清单缓存；拆分会引入多条状态写入路径，违背单一所有者约束 */
import { Emitter } from "@zcode/rpc";
import { mkdir, readFile, rename, stat as fsStat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAppConfigDir } from "../paths.js";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";
import type {
  ISub2ApiService,
  Sub2ApiAccountDetail,
  Sub2ApiGroupInfo,
  Sub2ApiKeyRecord,
  Sub2ApiKeyUsage,
  Sub2ApiKeyVerification,
  Sub2ApiLoginResult,
  Sub2ApiModelConfigOverride,
  Sub2ApiPublicSettings,
  Sub2ApiSiteKind,
  Sub2ApiSiteState,
  Sub2ApiSitesState,
  Sub2ApiSubscriptionInfo,
  Sub2ApiUsageSnapshot,
} from "./sub2api.js";

/** MikikoCC 自有站点：面板与网关均为固定地址。 */
export const SUB2API_DEFAULT_PANEL_BASE_URL = "https://mikiko.cc";
export const SUB2API_DEFAULT_GATEWAY_BASE_URL = "https://api.mikiko.cc";
export const SUB2API_MIKIKOCC_SITE_ID = "mikikocc";
const MAX_PROJECTED_MODELS = 60;

interface StoredAccount {
  email: string;
  balanceUsd?: number;
  frozenUsd?: number;
  totalRechargedUsd?: number;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface StoredSite {
  id: string;
  kind: Sub2ApiSiteKind;
  panelBaseUrl: string;
  gatewayBaseUrl?: string;
  siteName?: string;
  account: StoredAccount | null;
  activeKeyId?: string;
  providerId?: string;
  /** 密钥记录本地缓存（面板登录或 listKeys 时刷新；含明文）。 */
  legacyKeys?: Sub2ApiKeyRecord[];
  /** 密钥 → 个人供应商 映射（每密钥一个供应商，供模型选择器分层展示）。 */
  providerBindings?: Array<{ keyId: string; keyName: string; providerId: string }>;
  /** 密钥 → 离线模型清单。 */
  keyModels?: Record<string, string[]>;
  /** 站点级启停：关闭后该站点全部密钥供应商在会话模型列表隐藏。默认 true。 */
  enabled?: boolean;
  /** 待绑定：从添加供应商新建的占位记录，等待用户填入真实站点地址。 */
  pendingBind?: boolean;
}

interface StoredConfigV2 {
  version: 2;
  sites: StoredSite[];
  /** 首次全量同步标记：登录后自动为所有密钥建供应商只做一次。 */
  providerSyncCompleted?: Record<string, boolean>;
  /** `${siteId}:${keyId}:${model}` → 模型配置覆盖。 */
  modelConfigs: Record<string, Sub2ApiModelConfigOverride>;
}

interface Sub2ApiServiceDependencies {
  providerSettingsService: IProviderSettingsService;
}

interface PanelEnvelope<T> {
  code: number;
  message: string;
  reason?: string;
  data?: T;
}

function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function normalizeBaseUrl(input: string): string {
  const trimmed = trimTrailingSlash(input);
  if (!trimmed) {
    throw new Error("地址不能为空");
  }
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseEnvelopeText(text: string, status: number): PanelEnvelope<unknown> {
  try {
    return JSON.parse(text) as PanelEnvelope<unknown>;
  } catch {
    return { code: status, message: text.slice(0, 200) };
  }
}

/**
 * 虚拟模型（sub2api 网关侧合成，非真实可调用模型）：同步时整体过滤，不进供应商模型列表，
 * 也不参与 API 格式推断的前缀判定（用户需求 2026-09-24）。
 */
const SUB2API_VIRTUAL_MODEL_IDS = new Set(["codex-auto-review"]);

function filterVirtualModels(models: readonly string[]): string[] {
  return models.filter((model) => !SUB2API_VIRTUAL_MODEL_IDS.has(model));
}

/**
 * API 格式推断（含 Response 规则，用户需求 2026-09-24）：
 * - anthropic 平台 → anthropic-messages
 * - openai 平台 且 密钥下所有模型均为 gpt- 前缀 → openai-responses（GPT 系列默认走 Response API）
 * - 其他 → openai-chat-completions
 * 注意：此值仅在新建供应商时写入；已有供应商同步不覆盖用户手动改过的格式（差量更新语义）。
 */
function inferApiType(
  platform: string | undefined,
  models: readonly string[],
): "openai-chat-completions" | "anthropic-messages" | "openai-responses" {
  if (platform === "anthropic") {
    return "anthropic-messages";
  }
  const effectiveModels = filterVirtualModels(models);
  if (
    platform === "openai" &&
    effectiveModels.length > 0 &&
    effectiveModels.every((model) => model.startsWith("gpt-"))
  ) {
    return "openai-responses";
  }
  return "openai-chat-completions";
}

function parseModelIds(payload: unknown): string[] {
  const data = (payload as { data?: Array<{ id?: string }> } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
    .filter((id) => id.length > 0 && !SUB2API_VIRTUAL_MODEL_IDS.has(id))
    .sort((a, b) => a.localeCompare(b));
}

function isoDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function createSub2ApiService(deps: Sub2ApiServiceDependencies): ISub2ApiService {
  const configFile = join(getAppConfigDir(), "sub2api.json");
  const changeEmitter = new Emitter<Sub2ApiSitesState>();
  let cached: StoredConfigV2 | null = null;
  let cachedMtime: number | undefined;

  function defaultMikikoSite(): StoredSite {
    return {
      id: SUB2API_MIKIKOCC_SITE_ID,
      kind: "mikikocc",
      panelBaseUrl: SUB2API_DEFAULT_PANEL_BASE_URL,
      gatewayBaseUrl: SUB2API_DEFAULT_GATEWAY_BASE_URL,
      siteName: "MikikoCC",
      account: null,
    };
  }

  async function loadConfig(): Promise<StoredConfigV2> {
    if (cached) {
      // 跨进程缓存失效：desktop host 与 web server 各自持有 cached，一方删改写盘后
      // 另一方内存里仍是旧数据（表现为已删站点"复活"后被静默写回磁盘）。
      // 每次 cached 命中前比对磁盘 mtime，变了就丢弃内存缓存重读。
      try {
        const fileStat = await fsStat(configFile);
        if (cachedMtime !== undefined && fileStat.mtimeMs > cachedMtime) {
          cached = null;
        }
      } catch {
        // 文件不存在（首次运行）——保留 cached 走正常读盘流程。
      }
      if (cached) {
        return cached;
      }
    }
    const fallback: StoredConfigV2 = { version: 2, sites: [defaultMikikoSite()], modelConfigs: {} };
    try {
      const raw = JSON.parse(await readFile(configFile, "utf-8")) as Record<string, unknown>;
      if (raw.version === 2 && Array.isArray(raw.sites)) {
        cached = raw as unknown as StoredConfigV2;
      } else {
        // v1 单站点结构迁移为 MikikoCC 站点。
        const legacy = raw as {
          panelBaseUrl?: string;
          gatewayBaseUrl?: string;
          keys?: Array<{
            id: string;
            name: string;
            apiKey: string;
            groupLabel?: string;
            platform?: string;
          }>;
          activeKeyId?: string;
          providerId?: string;
          account?: { email?: string; balanceUsd?: number } | null;
          panelAccessToken?: string;
          refreshToken?: string;
        };
        cached = { version: 2, sites: [defaultMikikoSite()], modelConfigs: {} };
        const site = cached.sites[0] as StoredSite;
        site.panelBaseUrl = trimTrailingSlash(legacy.panelBaseUrl ?? site.panelBaseUrl);
        site.gatewayBaseUrl = trimTrailingSlash(legacy.gatewayBaseUrl ?? site.gatewayBaseUrl ?? "");
        site.activeKeyId = legacy.activeKeyId;
        site.providerId = legacy.providerId;
        site.legacyKeys = Array.isArray(legacy.keys) ? (legacy.keys as Sub2ApiKeyRecord[]) : [];
        if (legacy.account?.email) {
          site.account = {
            email: legacy.account.email,
            balanceUsd: legacy.account.balanceUsd,
            accessToken: legacy.panelAccessToken,
            refreshToken: legacy.refreshToken,
          };
        }
      }
    } catch {
      cached = fallback;
    }
    if (!cached.sites.some((site) => site.kind === "mikikocc")) {
      cached.sites.unshift(defaultMikikoSite());
    }
    return cached;
  }

  async function saveConfig(next: StoredConfigV2): Promise<void> {
    cached = next;
    await mkdir(dirname(configFile), { recursive: true });
    const tmp = `${configFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    await rename(tmp, configFile);
    try {
      cachedMtime = (await fsStat(configFile)).mtimeMs;
    } catch {
      // mtime 记录失败不影响写盘结果。
    }
    changeEmitter.fire(toSitesState(next));
  }

  /** 静默持久化：写盘但不广播 onDidChange。
   *  listKeys/用量等高频刷新会频繁更新缓存；若每次都 fire，UI 订阅 → 再拉取 → 再写盘
   *  形成循环，表现为订阅/分组信息忽闪忽现。只有账号与结构变更才走 saveConfig 广播。 */
  async function persistSilently(next: StoredConfigV2): Promise<void> {
    cached = next;
    await mkdir(dirname(configFile), { recursive: true });
    const tmp = `${configFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    await rename(tmp, configFile);
    try {
      cachedMtime = (await fsStat(configFile)).mtimeMs;
    } catch {
      // 同上。
    }
  }

  function toSiteState(site: StoredSite): Sub2ApiSiteState {
    return {
      siteId: site.id,
      kind: site.kind,
      panelBaseUrl: site.panelBaseUrl,
      gatewayBaseUrl: site.gatewayBaseUrl || site.panelBaseUrl,
      siteName: site.siteName,
      account: site.account
        ? {
            email: site.account.email,
            balanceUsd: site.account.balanceUsd,
            frozenUsd: site.account.frozenUsd,
            totalRechargedUsd: site.account.totalRechargedUsd,
          }
        : null,
      keys: (site.legacyKeys ?? []).map((key) => ({ ...key, active: key.id === site.activeKeyId })),
      activeKeyId: site.activeKeyId,
      providerId: site.providerId,
      providerBindings: site.providerBindings ?? [],
      keyModels: site.keyModels ?? {},
      enabled: site.enabled !== false,
      pendingBind: (site as StoredSite & { pendingBind?: boolean }).pendingBind === true,
    };
  }

  function toSitesState(config: StoredConfigV2): Sub2ApiSitesState {
    return { sites: config.sites.map((site) => toSiteState(site)) };
  }

  async function findSite(siteId: string): Promise<{ config: StoredConfigV2; site: StoredSite }> {
    const config = await loadConfig();
    const site = config.sites.find((entry) => entry.id === siteId);
    if (!site) {
      throw new Error("站点不存在");
    }
    return { config, site };
  }

  function gatewayBase(site: StoredSite): string {
    // settings/public 的 api_base_url 部分站点已带 /v1 后缀；统一剥掉，调用处再拼，
    // 避免 /v1/v1 双后缀导致网关 404。
    const raw = trimTrailingSlash(site.gatewayBaseUrl || site.panelBaseUrl);
    return raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
  }

  async function panelRequest<T>(
    site: StoredSite,
    path: string,
    init?: { method?: string; body?: unknown; auth?: boolean },
  ): Promise<
    { ok: true; data: T } | { ok: false; code: number; reason?: string; message: string }
  > {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (init?.auth !== false && site.account?.accessToken) {
      headers.Authorization = `Bearer ${site.account.accessToken}`;
    }
    const response = await fetch(`${site.panelBaseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(25_000),
    });
    const envelope = parseEnvelopeText(await response.text(), response.status);
    if (!response.ok || envelope.code !== 0) {
      return {
        ok: false,
        code: response.status,
        reason: envelope.reason,
        message: envelope.message || `HTTP ${response.status}`,
      };
    }
    return { ok: true, data: envelope.data as T };
  }

  async function refreshSiteToken(site: StoredSite): Promise<boolean> {
    if (!site.account?.refreshToken) {
      return false;
    }
    const response = await fetch(`${site.panelBaseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: site.account.refreshToken }),
      signal: AbortSignal.timeout(25_000),
    });
    const envelope = parseEnvelopeText(await response.text(), response.status);
    if (!response.ok || envelope.code !== 0) {
      return false;
    }
    const data = (envelope.data ?? {}) as Record<string, unknown>;
    const accessToken = pickString(data, ["access_token"]);
    const refreshToken = pickString(data, ["refresh_token"]);
    if (!accessToken) {
      return false;
    }
    site.account = {
      ...site.account,
      accessToken,
      refreshToken: refreshToken ?? site.account.refreshToken,
      expiresAt: asNumber(data.expires_in)
        ? Date.now() + (asNumber(data.expires_in) as number) * 1000
        : undefined,
    };
    return true;
  }

  async function panelRequestWithRefresh<T>(
    site: StoredSite,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<
    { ok: true; data: T } | { ok: false; code: number; reason?: string; message: string }
  > {
    const first = await panelRequest<T>(site, path, init);
    if (first.ok || first.code !== 401) {
      return first;
    }
    if (await refreshSiteToken(site)) {
      return panelRequest<T>(site, path, init);
    }
    return first;
  }

  async function fetchGatewayModels(
    site: StoredSite,
    apiKey: string,
  ): Promise<Sub2ApiKeyVerification> {
    try {
      const response = await fetch(`${gatewayBase(site)}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const envelope = parseEnvelopeText(await response.text(), response.status);
        return {
          ok: false,
          modelCount: 0,
          models: [],
          errorCode: response.status === 401 || response.status === 403 ? "invalid-key" : "unknown",
          errorMessage: envelope.message || `HTTP ${response.status}`,
        };
      }
      const models = parseModelIds(await response.json());
      if (models.length === 0) {
        return {
          ok: false,
          modelCount: 0,
          models: [],
          errorCode: "invalid-key",
          errorMessage: "站点未返回任何可用模型（检查 Key 所属分组的模型白名单）",
        };
      }
      return { ok: true, modelCount: models.length, models };
    } catch (error) {
      return {
        ok: false,
        modelCount: 0,
        models: [],
        errorCode: "network",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function modelConfigKey(siteId: string, keyId: string, model: string): string {
    return `${siteId}:${keyId}:${model}`;
  }

  function buildModelConfig(override: Sub2ApiModelConfigOverride): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    if (typeof override.enabled === "boolean") {
      config.enabled = override.enabled;
    }
    if (typeof override.contextWindow === "number") {
      config.properties = { contextWindow: override.contextWindow };
    }
    return config;
  }

  /** 激活 Key → 投影个人供应商；registry 1s 轮询让 agent 进程免重启拿到新配置。 */
  async function projectProvider(
    config: StoredConfigV2,
    site: StoredSite,
    key: Sub2ApiKeyRecord,
  ): Promise<string | undefined> {
    const verification = await fetchGatewayModels(site, key.apiKey);
    if (!verification.ok) {
      throw new Error(`Key 验证失败：${verification.errorMessage ?? "unknown"}`);
    }
    const models = verification.models.slice(0, MAX_PROJECTED_MODELS);
    // 手动添加的自定义模型（modelConfigs 中标记 custom 的同站点同密钥条目）并入清单。
    const customModels = Object.entries(config.modelConfigs)
      .filter(
        ([configKey, override]) =>
          override.custom === true && configKey.startsWith(`${site.id}:${key.id}:`),
      )
      .map(([configKey]) => configKey.split(":")[2] ?? "")
      .filter((model) => model.length > 0 && !models.includes(model));
    models.push(...customModels.slice(0, MAX_PROJECTED_MODELS - models.length));
    const apiConfig = {
      type: inferApiType(key.platform, models),
      baseUrl: `${gatewayBase(site)}/v1`,
    } as const;
    const accessConfig = { type: "api-key", apiKey: key.apiKey } as const;
    const providerName = site.kind === "mikikocc" ? "MikikoCC" : site.siteName || "Sub2api";

    if (!site.providerId) {
      const created = await deps.providerSettingsService.createPersonalProvider({
        providerName,
        initialConfig: {
          api: apiConfig,
          access: accessConfig,
          personalModelIds: models,
          modelOrder: models,
        },
      });
      site.providerId = created.providerId;
      site.activeKeyId = key.id;
      for (const modelId of models) {
        const override = config.modelConfigs[modelConfigKey(site.id, key.id, modelId)];
        try {
          await deps.providerSettingsService.addPersonalModel(
            created.providerId,
            modelId,
            override ? buildModelConfig(override) : {},
            true,
          );
        } catch {
          // 模型条目以网关清单为准，已存在时忽略。
        }
      }
      return created.providerId;
    }

    await deps.providerSettingsService.savePersonalProviderOverlay(
      site.providerId,
      {
        api: apiConfig,
        access: accessConfig,
        personalModelIds: models,
        modelOrder: models,
      },
      // 历史投影可能被用户在供应商列表中禁用过；激活密钥是明确的启用语义，强制恢复。
      { enabled: true },
    );
    for (const modelId of models) {
      const override = config.modelConfigs[modelConfigKey(site.id, key.id, modelId)];
      try {
        await deps.providerSettingsService.addPersonalModel(
          site.providerId,
          modelId,
          override ? buildModelConfig(override) : {},
          true,
        );
      } catch {
        // 同上。
      }
    }
    site.activeKeyId = key.id;
    return site.providerId;
  }

  function normalizeKeyItem(
    item: Record<string, unknown>,
    groups: Sub2ApiGroupInfo[],
  ): Sub2ApiKeyRecord {
    const groupId = asNumber(item.group_id) ?? null;
    const group = groups.find((entry) => entry.id === groupId);
    const nestedGroup = item.group as Record<string, unknown> | undefined;
    return {
      id: String(item.id ?? ""),
      name: pickString(item, ["name"]) ?? `Key ${String(item.id ?? "")}`,
      apiKey: pickString(item, ["key"]) ?? "",
      status: pickString(item, ["status"]) ?? "active",
      groupId,
      groupLabel: pickString(nestedGroup ?? {}, ["name"]) ?? group?.name,
      platform: pickString(nestedGroup ?? {}, ["platform"]) ?? group?.platform,
      quotaUsd: pickNumber(item, ["quota"]),
      quotaUsedUsd: pickNumber(item, ["quota_used"]),
      expiresAt: pickString(item, ["expires_at"]) ?? null,
      lastUsedAt: pickString(item, ["last_used_at"]) ?? null,
    };
  }

  async function fetchGroups(site: StoredSite): Promise<Sub2ApiGroupInfo[]> {
    const result = await panelRequestWithRefresh<Array<Record<string, unknown>>>(
      site,
      "/api/v1/groups/available",
    );
    if (!result.ok || !Array.isArray(result.data)) {
      return [];
    }
    return result.data.map((entry) => ({
      id: asNumber(entry.id) ?? 0,
      name: pickString(entry, ["name"]) ?? String(entry.id),
      platform: pickString(entry, ["platform"]),
      description: pickString(entry, ["description"]),
      subscriptionType: pickString(entry, ["subscription_type"]),
    }));
  }

  async function fetchAndStoreKeys(site: StoredSite, groups: Sub2ApiGroupInfo[]): Promise<number> {
    const result = await panelRequestWithRefresh<{ items?: Array<Record<string, unknown>> }>(
      site,
      "/api/v1/keys?page=1&page_size=200",
    );
    if (!result.ok || !Array.isArray(result.data?.items)) {
      return 0;
    }
    const records = result.data.items
      .map((item) => normalizeKeyItem(item, groups))
      .filter((key) => key.apiKey.length > 0);
    site.legacyKeys = records;
    return records.length;
  }

  function keyFromSite(site: StoredSite, keyId: string): Sub2ApiKeyRecord | undefined {
    return (site.legacyKeys ?? []).find((entry) => entry.id === keyId);
  }

  function loginError(
    code: number,
    reason: string | undefined,
    message: string,
  ): Error & { errorCode: string; tempToken?: string } {
    const error = new Error(message) as Error & { errorCode: string; tempToken?: string };
    if (reason === "TURNSTILE_VERIFICATION_FAILED") {
      error.errorCode = "captcha";
    } else if (reason === "TURNSTILE_NOT_CONFIGURED") {
      error.errorCode = "captcha-not-configured";
    } else if (code === 401 || code === 400) {
      error.errorCode = "invalid-credential";
    } else {
      error.errorCode = "unknown";
    }
    return error;
  }

  // 同步互斥锁（2026-09-24 修复登录后双同步并发）：login() 内的服务层自动同步与
  // UI 层 autoSync 并发时，双方读到同一份空 bindings → 都走创建路径 → 重名副本。
  // 同一站点同一时刻只允许一个 syncProviders 在跑，后来者复用在途 Promise。
  const syncInFlight = new Map<string, Promise<Sub2ApiSiteState>>();

  // 模型推荐缓存（2026-09-24 用户需求）：同步时按「模型 ID + API 格式」走智能配置
  // 匹配（忽略 baseUrl 的官方端点规则），同一组合只解析一次；多密钥同模型、重复
  // 同步直接复用，避免重复解析与逐模型重复写盘。null 表示已解析且无推荐。
  const modelRecommendationCache = new Map<string, Record<string, unknown> | null>();

  async function resolveModelRecommendation(
    modelId: string,
    apiType: string,
  ): Promise<Record<string, unknown> | null> {
    const cacheKey = `${apiType}::${modelId}`;
    if (modelRecommendationCache.has(cacheKey)) {
      return modelRecommendationCache.get(cacheKey) ?? null;
    }
    let value: Record<string, unknown> | null = null;
    try {
      const resolved = await deps.providerSettingsService.resolveRelayModelRecommendation({
        modelId,
        apiType,
      });
      value =
        resolved && Object.keys(resolved).length > 0 ? (resolved as Record<string, unknown>) : null;
    } catch {
      // 推荐解析失败不阻断同步：模型按无推荐配置落盘，与旧行为一致。
    }
    modelRecommendationCache.set(cacheKey, value);
    return value;
  }

  // 配置写串行化（2026-09-23 修复站点丢失/复活）：本服务的写路径全部是
  // 「loadConfig 捕获快照 → await 网络（超时可达 25s）→ 用快照写回」的形状，
  // 没有串行化时，余额/密钥 60-120s 定时刷新的在途流程会用进入前捕获的旧快照
  // 覆盖磁盘：并发 addSite 刚写入的占位站点被冲掉（绑定地址报「站点不存在」）、
  // 已删除站点被复活（删除提示成功但记录仍在）。所有改写配置的方法经
  // serializedService 整体排队，保证单进程内「读-改-写」原子；网络等待也在
  // 队列内——这些是用户节奏的低频操作，正确性优先于吞吐。内部自调用
  // （login → syncProviders、refreshAccount → getAccountDetail）持有 raw service
  // 引用、绕过代理直接进原方法，天然不会重入排队造成死锁。
  let configWriteChain: Promise<unknown> = Promise.resolve();

  function withConfigLock<T>(run: () => Promise<T>): Promise<T> {
    const task = configWriteChain.then(run, run);
    // 前序任务失败只向它自己的调用方传播，不能卡死整条队列。
    configWriteChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 必须整体串行化的写方法；纯读方法（getSites/getModelConfig 等）不加锁。 */
  const configWriteMethods: ReadonlySet<string> = new Set([
    "addSite",
    "bindSiteAddress",
    "removeSite",
    "login",
    "loginWith2FA",
    "logout",
    "getAccountDetail",
    "refreshAccount",
    "listKeys",
    "createKey",
    "updateKey",
    "deleteKey",
    "activateKey",
    "refreshKeyModels",
    "syncProviders",
    "setSiteEnabled",
    "setModelConfig",
  ]);

  const service: ISub2ApiService = {
    onDidChange: (listener) => changeEmitter.event(listener),
    async getSites() {
      return toSitesState(await loadConfig());
    },
    async getSiteState(siteId) {
      const { site } = await findSite(siteId);
      return toSiteState(site);
    },
    async addSite(baseUrl) {
      const config = await loadConfig();
      const panelBaseUrl = normalizeBaseUrl(baseUrl);
      // 占位地址：从「添加供应商」新建的待绑定记录，跳过远端校验，等待用户填入真实地址。
      const placeholder = panelBaseUrl === "https://about:blank";
      if (!placeholder) {
        const probe = await fetch(`${panelBaseUrl}/api/v1/settings/public`, {
          signal: AbortSignal.timeout(15_000),
        });
        const envelope = parseEnvelopeText(await probe.text(), probe.status);
        if (!probe.ok || envelope.code !== 0) {
          throw new Error(`该地址不是有效的 Sub2API 服务（${envelope.message || probe.status}）`);
        }
      }
      const site: StoredSite = {
        id: `sub2api-${randomUUID().slice(0, 8)}`,
        kind: "sub2api",
        panelBaseUrl: placeholder ? "" : panelBaseUrl,
        pendingBind: placeholder,
        siteName: undefined,
        account: null,
      };
      const next = { ...config, sites: [...config.sites, site] };
      await saveConfig(next);
      return toSiteState(site);
    },
    async bindSiteAddress(siteId, baseUrl) {
      const { config, site } = await findSite(siteId);
      if (site.kind !== "sub2api") {
        throw new Error("MikikoCC 为内置站点，无需绑定地址");
      }
      const panelBaseUrl = normalizeBaseUrl(baseUrl);
      const probe = await fetch(`${panelBaseUrl}/api/v1/settings/public`, {
        signal: AbortSignal.timeout(15_000),
      });
      const envelope = parseEnvelopeText(await probe.text(), probe.status);
      if (!probe.ok || envelope.code !== 0) {
        throw new Error(`该地址不是有效的 Sub2API 服务（${envelope.message || probe.status}）`);
      }
      const settings = (envelope.data ?? {}) as Record<string, unknown>;
      const apiBaseUrl = pickString(settings, ["api_base_url"]);
      site.panelBaseUrl = panelBaseUrl;
      site.gatewayBaseUrl = apiBaseUrl
        ? trimTrailingSlash(apiBaseUrl).replace(/\/v1$/, "")
        : undefined;
      site.siteName =
        pickString(settings, ["site_name"]) ?? panelBaseUrl.replace(/^https?:\/\//, "");
      const store = site as StoredSite & { pendingBind?: boolean };
      store.pendingBind = false;
      await saveConfig({ ...config, sites: config.sites });
      return toSiteState(site);
    },

    async removeSite(siteId) {
      // 强制从磁盘重读（不用内存 cached）：removeSite 可能与 syncProviders 并发，
      // cached 可能是写盘前的旧引用，用它过滤 sites 会把已删站点在下一次 loadConfig 时复活。
      cached = null;
      const config = await loadConfig();
      const site = config.sites.find((entry) => entry.id === siteId);
      if (!site) {
        throw new Error("站点不存在");
      }
      if (site.kind === "mikikocc") {
        throw new Error("MikikoCC 为内置站点，不能删除");
      }
      // 级联删除该站点全部密钥对应的个人供应商。删除失败时重试一次；
      // 重试仍失败则明确抛错（而不是静默吞掉留下「自定义供应商」幽灵）。
      for (const binding of site.providerBindings ?? []) {
        let deleted = false;
        for (let attempt = 0; attempt < 2 && !deleted; attempt += 1) {
          try {
            await deps.providerSettingsService.deletePersonalProvider(binding.providerId);
            deleted = true;
          } catch {
            // 首次失败重试一次；两次都失败在下方检查中抛错。
          }
        }
        if (!deleted) {
          // provider 删除失败会导致自定义供应商列表出现幽灵——宁可让删除站点操作报错重试。
          throw new Error(`删除密钥供应商失败（${binding.keyName}），请重试`);
        }
      }
      // 品牌前缀兜底清扫（2026-09-24 修复重登重复供应商）：bindings 只反映删站点那一刻的
      // 记录，历史上同步竞态/失败可能留下未登记的供应商；重加站点登录会按重名规则生成
      // "Claude 2" 这类副本。这里把该站点品牌前缀（"{brand} · "）开头的个人供应商全部删除。
      try {
        const brand = site.siteName || "Sub2api";
        const prefix = `${brand} · `.toLowerCase();
        const view = await deps.providerSettingsService.getView();
        const ghosts = view.providers.filter((provider) => {
          const name = provider.providerName?.trim().toLowerCase();
          return name != null && name.startsWith(prefix);
        });
        for (const ghost of ghosts) {
          await deps.providerSettingsService
            .deletePersonalProvider(ghost.providerId)
            .catch(() => undefined);
        }
      } catch {
        // 兜底清扫失败不阻断删除（bindings 主路径已执行）。
      }
      const next = { ...config, sites: config.sites.filter((entry) => entry.id !== siteId) };
      await saveConfig(next);
      return toSitesState(next);
    },
    async getPublicSettings(siteId) {
      const { site } = await findSite(siteId);
      const response = await fetch(`${site.panelBaseUrl}/api/v1/settings/public`, {
        signal: AbortSignal.timeout(15_000),
      });
      const envelope = parseEnvelopeText(await response.text(), response.status);
      if (!response.ok || envelope.code !== 0) {
        throw new Error(`站点配置读取失败：${envelope.message || response.status}`);
      }
      const settings = (envelope.data ?? {}) as Record<string, unknown>;
      return {
        siteName: pickString(settings, ["site_name"]),
        apiBaseUrl: pickString(settings, ["api_base_url"]),
        registrationEnabled: settings.registration_enabled === true,
        turnstileEnabled: settings.turnstile_enabled === true,
        turnstileSiteKey: pickString(settings, ["turnstile_site_key"]),
      };
    },
    async login(request) {
      const { config, site } = await findSite(request.siteId);
      const login = await panelRequest<Record<string, unknown>>(site, "/api/v1/auth/login", {
        method: "POST",
        auth: false,
        body: {
          email: request.email.trim(),
          password: request.password,
          ...(request.turnstileToken ? { turnstile_token: request.turnstileToken } : {}),
        },
      });
      if (!login.ok) {
        throw loginError(login.code, login.reason, login.message);
      }
      const data = login.data;
      if (data.requires_2fa === true) {
        const error = loginError(400, undefined, "该账号已启用两步验证，请输入动态验证码");
        error.errorCode = "requires-2fa";
        error.tempToken = pickString(data, ["temp_token"]);
        throw error;
      }
      const accessToken = pickString(data, ["access_token"]);
      if (!accessToken) {
        throw loginError(500, undefined, "登录响应缺少 access_token");
      }
      const user = (data.user ?? {}) as Record<string, unknown>;
      site.account = {
        email: pickString(user, ["email"]) ?? request.email.trim(),
        balanceUsd: pickNumber(user, ["balance"]),
        accessToken,
        refreshToken: pickString(data, ["refresh_token"]),
        expiresAt: asNumber(data.expires_in)
          ? Date.now() + (asNumber(data.expires_in) as number) * 1000
          : undefined,
      };
      const groups = await fetchGroups(site).catch(() => []);
      const syncedKeyCount = await fetchAndStoreKeys(site, groups);
      await saveConfig({ ...config, sites: config.sites });
      // 登录后自动同步供应商与模型列表（用户需求 #3）：不再依赖用户打开设置页才触发。
      try {
        await service.syncProviders(site.id);
      } catch {
        // 同步失败不阻断登录返回；用户进设置页可手动重试。
      }
      return { state: toSiteState(site), syncedKeyCount };
    },
    async loginWith2FA(request) {
      const { config, site } = await findSite(request.siteId);
      const login = await panelRequest<Record<string, unknown>>(site, "/api/v1/auth/login/2fa", {
        method: "POST",
        auth: false,
        body: { temp_token: request.tempToken, totp_code: request.totpCode.trim() },
      });
      if (!login.ok) {
        throw loginError(login.code, login.reason, login.message);
      }
      const accessToken = pickString(login.data, ["access_token"]);
      if (!accessToken) {
        throw loginError(500, undefined, "登录响应缺少 access_token");
      }
      const user = (login.data.user ?? {}) as Record<string, unknown>;
      site.account = {
        email: pickString(user, ["email"]) ?? site.account?.email ?? "",
        balanceUsd: pickNumber(user, ["balance"]),
        accessToken,
        refreshToken: pickString(login.data, ["refresh_token"]),
      };
      const groups = await fetchGroups(site).catch(() => []);
      const syncedKeyCount = await fetchAndStoreKeys(site, groups);
      await saveConfig({ ...config, sites: config.sites });
      // 登录后自动同步（2FA）供应商与模型列表（用户需求 #3）：不再依赖用户打开设置页才触发。
      try {
        await service.syncProviders(site.id);
      } catch {
        // 同步失败不阻断登录返回；用户进设置页可手动重试。
      }
      return { state: toSiteState(site), syncedKeyCount };
    },
    async logout(siteId) {
      const { config, site } = await findSite(siteId);
      site.account = null;
      site.legacyKeys = [];
      await saveConfig({ ...config, sites: config.sites });
      return toSiteState(site);
    },
    async getAccountDetail(siteId) {
      const { site } = await findSite(siteId);
      if (!site.account) {
        throw new Error("站点未登录");
      }
      const [me, bootstrap, groups, subs] = await Promise.all([
        panelRequestWithRefresh<Record<string, unknown>>(site, "/api/v1/auth/me").catch(() => null),
        panelRequestWithRefresh<Record<string, unknown>>(site, "/api/v1/console/bootstrap").catch(
          () => null,
        ),
        fetchGroups(site),
        panelRequestWithRefresh<Array<Record<string, unknown>>>(
          site,
          "/api/v1/subscriptions",
        ).catch(() => null),
      ]);
      const meData = me && me.ok ? (me.data ?? {}) : {};
      const meUser = (meData.user as Record<string, unknown> | undefined) ?? meData;
      const wallet =
        bootstrap && bootstrap.ok
          ? ((bootstrap.data as Record<string, unknown>).wallet as
              | Record<string, unknown>
              | undefined)
          : undefined;
      const balanceUsd =
        pickNumber(meUser, ["balance"]) ??
        pickNumber(wallet ?? {}, ["available_balance"]) ??
        site.account.balanceUsd;
      if (site.account) {
        site.account.balanceUsd = balanceUsd;
        site.account.frozenUsd = pickNumber(meUser, ["frozen_balance"]);
        site.account.totalRechargedUsd = pickNumber(meUser, ["total_recharged"]);
      }
      const subscriptions: Sub2ApiSubscriptionInfo[] = [];
      if (subs && subs.ok && Array.isArray(subs.data)) {
        for (const item of subs.data) {
          const group = (item.group as Record<string, unknown> | undefined) ?? {};
          const windows: Sub2ApiSubscriptionInfo["windows"] = [];
          for (const window of ["daily", "weekly", "monthly"] as const) {
            const used = pickNumber(item, [`${window}_usage_usd`]);
            const limit =
              pickNumber(item, [`${window}_limit_usd`]) ??
              pickNumber(group, [`${window}_limit_usd`]);
            if (used !== undefined || limit !== undefined) {
              windows.push({
                window,
                usedUsd: used ?? 0,
                limitUsd: limit ?? 0,
                resetAt: pickString(item, [`${window}_reset_at`]),
              });
            }
          }
          subscriptions.push({
            id: asNumber(item.id) ?? 0,
            groupLabel: pickString(group, ["name"]) ?? `订阅 ${String(item.id ?? "")}`,
            status: pickString(item, ["status"]) ?? "active",
            startsAt: pickString(item, ["starts_at"]),
            expiresAt: pickString(item, ["expires_at"]),
            windows,
          });
        }
      }
      return {
        account: {
          email: site.account.email,
          balanceUsd,
          frozenUsd: site.account.frozenUsd,
          totalRechargedUsd: site.account.totalRechargedUsd,
        },
        subscriptions,
        groups,
      };
    },
    async refreshAccount(siteId) {
      await service.getAccountDetail(siteId);
      const { config } = await findSite(siteId);
      await persistSilently({ ...config, sites: config.sites });
      const { site } = await findSite(siteId);
      return toSiteState(site);
    },
    async listKeys(siteId) {
      const { config, site } = await findSite(siteId);
      const groups = await fetchGroups(site).catch(() => []);
      await fetchAndStoreKeys(site, groups);
      // 高频刷新走静默持久化，避免 onDidChange → UI 重拉 → 再写盘的循环。
      await persistSilently({ ...config, sites: config.sites });
      return (site.legacyKeys ?? []).map((key) => ({
        ...key,
        active: key.id === site.activeKeyId,
      }));
    },
    async createKey(siteId, request) {
      const { config, site } = await findSite(siteId);
      const result = await panelRequestWithRefresh<Record<string, unknown>>(site, "/api/v1/keys", {
        method: "POST",
        body: { name: request.name, group_id: request.groupId ?? null },
      });
      if (!result.ok) {
        throw new Error(`创建密钥失败：${result.message}`);
      }
      const groups = await fetchGroups(site).catch(() => []);
      const record = normalizeKeyItem(result.data, groups);
      site.legacyKeys = [...(site.legacyKeys ?? []).filter((key) => key.id !== record.id), record];
      await persistSilently({ ...config, sites: config.sites });
      return record;
    },
    async updateKey(siteId, keyId, request) {
      const { config, site } = await findSite(siteId);
      const body: Record<string, unknown> = {};
      if (request.name !== undefined) {
        body.name = request.name;
      }
      if (request.groupId !== undefined) {
        body.group_id = request.groupId;
      }
      if (request.status !== undefined) {
        body.status = request.status;
      }
      if (request.quotaUsd !== undefined) {
        body.quota = request.quotaUsd;
      }
      const result = await panelRequestWithRefresh<Record<string, unknown>>(
        site,
        `/api/v1/keys/${encodeURIComponent(keyId)}`,
        { method: "PUT", body },
      );
      if (!result.ok) {
        throw new Error(`更新密钥失败：${result.message}`);
      }
      const groups = await fetchGroups(site).catch(() => []);
      const record = normalizeKeyItem(result.data, groups);
      site.legacyKeys = (site.legacyKeys ?? []).map((key) =>
        key.id === record.id ? { ...key, ...record } : key,
      );
      await persistSilently({ ...config, sites: config.sites });
      return record;
    },
    async deleteKey(siteId, keyId) {
      const { config, site } = await findSite(siteId);
      const result = await panelRequestWithRefresh<unknown>(
        site,
        `/api/v1/keys/${encodeURIComponent(keyId)}`,
        { method: "DELETE" },
      );
      if (!result.ok) {
        throw new Error(`删除密钥失败：${result.message}`);
      }
      site.legacyKeys = (site.legacyKeys ?? []).filter((key) => key.id !== keyId);
      if (site.activeKeyId === keyId) {
        site.activeKeyId = site.legacyKeys?.[0]?.id;
      }
      await persistSilently({ ...config, sites: config.sites });
      return (site.legacyKeys ?? []).map((key) => ({
        ...key,
        active: key.id === site.activeKeyId,
      }));
    },
    async activateKey(siteId, keyId) {
      const { config, site } = await findSite(siteId);
      const key = keyFromSite(site, keyId);
      if (!key) {
        throw new Error("密钥不存在，请先刷新密钥列表");
      }
      await projectProvider(config, site, key);
      await saveConfig({ ...config, sites: config.sites });
      return toSiteState(site);
    },
    async verifyKey(siteId, apiKey) {
      const { site } = await findSite(siteId);
      return fetchGatewayModels(site, apiKey);
    },
    async refreshActiveKeyUsage(siteId) {
      const { site } = await findSite(siteId);
      const key = site.activeKeyId ? keyFromSite(site, site.activeKeyId) : undefined;
      if (!key) {
        return null;
      }
      const verification = await fetchGatewayModels(site, key.apiKey);
      try {
        const response = await fetch(`${gatewayBase(site)}/v1/usage`, {
          headers: { Authorization: `Bearer ${key.apiKey}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          return { models: verification.models };
        }
        const payload = (await response.json()) as {
          status?: string;
          quota?: { remaining?: number };
          usage?: { today?: { requests?: number } };
        };
        return {
          status: payload.status,
          quotaRemainingUsd: payload.quota?.remaining,
          requestsToday: payload.usage?.today?.requests,
          models: verification.models,
        };
      } catch {
        return { models: verification.models };
      }
    },
    async getUsageSnapshot(siteId, range) {
      const { site } = await findSite(siteId);
      if (!site.account) {
        throw new Error("站点未登录");
      }
      const days = range === "7d" ? 7 : 30;
      const query = `start_date=${isoDate(-(days - 1))}&end_date=${isoDate(0)}`;
      const result = await panelRequestWithRefresh<Record<string, unknown>>(
        site,
        `/api/v1/usage/dashboard/snapshot-v2?${query}&include_trend=true&include_models=true`,
      );
      const payload = result.ok ? (result.data ?? {}) : {};
      const trend = Array.isArray(payload.trend)
        ? (payload.trend as Array<Record<string, unknown>>)
        : [];
      const models = Array.isArray(payload.models)
        ? (payload.models as Array<Record<string, unknown>>)
        : [];
      const points = trend.map((item) => ({
        date: pickString(item, ["date", "day", "time"]) ?? "",
        requests: pickNumber(item, ["requests", "request_count"]) ?? 0,
        tokens: pickNumber(item, ["tokens", "total_tokens"]) ?? 0,
        costUsd: pickNumber(item, ["actual_cost", "cost"]) ?? 0,
      }));
      const modelUsage = models.map((item) => {
        const input = pickNumber(item, ["input_tokens", "inputTokens"]) ?? 0;
        const output = pickNumber(item, ["output_tokens", "outputTokens"]) ?? 0;
        const cache = pickNumber(item, ["cache_tokens", "cached_input_tokens"]) ?? 0;
        return {
          model: pickString(item, ["model", "model_name"]) ?? "unknown",
          requests: pickNumber(item, ["requests", "request_count"]) ?? 0,
          inputTokens: input,
          outputTokens: output,
          totalTokens: pickNumber(item, ["total_tokens"]) ?? input + output + cache,
          costUsd: pickNumber(item, ["actual_cost", "cost"]) ?? 0,
        };
      });
      return {
        siteId,
        range,
        generatedAt: Date.now(),
        points,
        models: modelUsage,
        totals: {
          requests: points.reduce((sum, point) => sum + point.requests, 0),
          tokens: points.reduce((sum, point) => sum + point.tokens, 0),
          costUsd: points.reduce((sum, point) => sum + point.costUsd, 0),
        },
      };
    },
    async setSiteEnabled(siteId, enabled) {
      const { config, site } = await findSite(siteId);
      site.enabled = enabled;
      // 站点开关直接映射到该站点全部密钥供应商的启停（模型选择器可见性）。
      for (const binding of site.providerBindings ?? []) {
        await deps.providerSettingsService
          .savePersonalProviderOverlay(binding.providerId, {}, { enabled })
          .catch(() => undefined);
      }
      await saveConfig({ ...config, sites: config.sites });
      return toSiteState(site);
    },
    async refreshKeyModels(siteId, keyId) {
      const { config, site } = await findSite(siteId);
      const key = keyFromSite(site, keyId);
      if (!key) {
        throw new Error("密钥不存在，请先刷新密钥列表");
      }
      const verification = await fetchGatewayModels(site, key.apiKey);
      if (!verification.ok) {
        throw new Error(verification.errorMessage ?? "模型清单拉取失败");
      }
      site.keyModels = { ...(site.keyModels ?? {}), [keyId]: verification.models };
      await persistSilently({ ...config, sites: config.sites });
      return verification.models;
    },
    async syncProviders(siteId) {
      // 互斥（2026-09-24）：同站点在途同步直接复用结果——login() 内的服务层自动同步
      // 与 UI 层 autoSync 并发时，双方读到同一份空 bindings → 都走创建路径 → 重名副本。
      const existing = syncInFlight.get(siteId);
      if (existing) {
        return existing;
      }
      const run = async (): Promise<Sub2ApiSiteState> => {
        // 强制从磁盘重读：与其他写操作并发时 cached 可能过期。
        cached = null;
        const { config, site } = await findSite(siteId);
        const keys = (site.legacyKeys ?? []).filter((key) => key.apiKey.length > 0);
        const brand = site.kind === "mikikocc" ? "MikikoCC" : site.siteName || "Sub2api";
        // 统一品牌前缀命名：跨站点密钥可能同名，前缀从源头避免冲突与自动后缀污染。
        const providerLabelFor = (keyName: string) => `${brand} · ${keyName || "Key"}`;
        const siteEnabled = site.enabled !== false;
        const bindings = [...(site.providerBindings ?? [])];
        const orphanProviderIds: string[] = [];

        // 删除已不存在的密钥对应的供应商。
        for (const binding of bindings) {
          if (!keys.some((key) => key.id === binding.keyId)) {
            orphanProviderIds.push(binding.providerId);
          }
        }
        for (const providerId of orphanProviderIds) {
          await deps.providerSettingsService
            .deletePersonalProvider(providerId)
            .catch(() => undefined);
        }
        const effectiveBindings = bindings.filter(
          (binding) => !orphanProviderIds.includes(binding.providerId),
        );

        for (const key of keys) {
          try {
            let binding = effectiveBindings.find((entry) => entry.keyId === key.id);
            if (!binding) {
              // 孤儿认领（2026-09-24 修复重登重复）：站点重加后 keyId 全新，但同名供应商可能
              // 仍存在（删除时绑定缺失/历史竞态遗留）。按「品牌 · 密钥名」全局查找并认领，
              // 避免按重名规则生成 "Claude 2" 副本。
              const expectedName = providerLabelFor(key.name);
              try {
                const view = await deps.providerSettingsService.getView();
                const candidate = view.providers.find(
                  (provider) =>
                    provider.providerName?.trim().toLowerCase() ===
                    expectedName.trim().toLowerCase(),
                );
                if (candidate) {
                  effectiveBindings.push({
                    keyId: key.id,
                    keyName: key.name,
                    providerId: candidate.providerId,
                  });
                  binding = effectiveBindings[effectiveBindings.length - 1];
                }
              } catch {
                // 视图读取失败走正常创建路径。
              }
            }
            // 模型清单取本地离线数据；未拉取过的密钥现场拉一次并落盘。
            let models = site.keyModels?.[key.id];
            if (!models || models.length === 0) {
              const verification = await fetchGatewayModels(site, key.apiKey);
              if (verification.ok) {
                models = verification.models;
                site.keyModels = { ...(site.keyModels ?? {}), [key.id]: models };
              } else {
                models = [];
              }
            }
            const customModels = Object.entries(config.modelConfigs)
              .filter(
                ([configKey, override]) =>
                  override.custom === true && configKey.startsWith(`${site.id}:${key.id}:`),
              )
              .map(([configKey]) => configKey.split(":")[2] ?? "")
              .filter((model) => model.length > 0 && !(models ?? []).includes(model));
            const allModels = [...(models ?? []), ...customModels].slice(0, MAX_PROJECTED_MODELS);
            if (allModels.length === 0) {
              continue;
            }
            const apiConfig = {
              type: inferApiType(key.platform, models ?? []),
              baseUrl: `${gatewayBase(site)}/v1`,
            } as const;
            const accessConfig = { type: "api-key", apiKey: key.apiKey } as const;

            if (!binding) {
              const created = await deps.providerSettingsService.createPersonalProvider({
                providerName: providerLabelFor(key.name),
                initialConfig: {
                  personalModelIds: allModels,
                  modelOrder: allModels,
                },
              });
              // createPersonalProvider 的 initialConfig 不落 api/access，创建后必须立即用
              // 完整 sparse overlay 写入端点与密钥，否则供应商不可执行、不进模型选择器。
              await deps.providerSettingsService.savePersonalProviderOverlay(
                created.providerId,
                {
                  api: apiConfig,
                  access: accessConfig,
                  personalModelIds: allModels,
                  modelOrder: allModels,
                },
                { enabled: siteEnabled && key.status === "active" },
              );
              for (const modelId of allModels) {
                const override = config.modelConfigs[modelConfigKey(site.id, key.id, modelId)];
                try {
                  // 智能配置（用户需求 2026-09-24）：同步模型按「ID + API 格式」匹配推荐
                  // 配置快照（输入类型/能力/推理等级），无用户覆盖时随条目落盘。
                  const recommendation = override
                    ? null
                    : await resolveModelRecommendation(modelId, apiConfig.type);
                  await deps.providerSettingsService.addPersonalModel(
                    created.providerId,
                    modelId,
                    override ? buildModelConfig(override) : (recommendation ?? {}),
                    true,
                  );
                } catch {
                  // 模型条目以清单为准，重复添加忽略。
                }
              }
              effectiveBindings.push({
                keyId: key.id,
                keyName: key.name,
                providerId: created.providerId,
              });
            } else {
              // 差量更新（用户需求 #4）：已有供应商的 api.type 以当前生效值为准——用户手动改过
              // （如 Response）的格式同步不得打回；当前无值（历史数据 type 未持久化）才写入
              // 本轮推断值。baseUrl 与密钥始终更新。
              let keepApiType: typeof apiConfig.type | undefined;
              // 模型合并：读取当前供应商的模型列表，保留不在同步清单里的（用户直接在供应商
              // 设置页添加的模型，spec #4.3 手动模型不删）。名称冲突时人工的已在 currentModels
              // 中，同步清单里的同名模型会被去重跳过。
              let mergedModels = allModels;
              // 已存在模型的个人配置视图：判断历史同步的模型是否需要补写推荐配置快照。
              let existingModelEntries = new Map<string, { personalExactConfig?: unknown }>();
              try {
                const currentView = await deps.providerSettingsService.getView();
                const currentProvider = currentView.providers.find(
                  (provider) => provider.providerId === binding.providerId,
                );
                // 显式保留当前 type（effectiveConfig 是生效配置；personalConfig 优先以覆盖为准）。
                const currentApi = (currentProvider?.personalConfig?.api ??
                  currentProvider?.effectiveConfig?.api) as
                  | { type?: typeof apiConfig.type }
                  | undefined;
                keepApiType = currentApi?.type;
                const currentModelIds: string[] =
                  currentProvider?.models?.map((m) => m.modelId) ?? [];
                existingModelEntries = new Map(
                  (currentProvider?.models ?? []).map((model) => [
                    model.modelId,
                    { personalExactConfig: model.personalExactConfig },
                  ]),
                );
                const syncedSet = new Set(allModels);
                const userAdded = currentModelIds.filter((id) => !syncedSet.has(id));
                if (userAdded.length > 0) {
                  mergedModels = [...allModels, ...userAdded].slice(0, MAX_PROJECTED_MODELS);
                }
              } catch {
                // 读取当前列表失败时退化为全量覆盖（与旧行为一致）。
              }
              const updateApiConfig = {
                ...(keepApiType ? { type: keepApiType } : { type: apiConfig.type }),
                baseUrl: apiConfig.baseUrl,
              } as typeof apiConfig;
              const overlayOk = await deps.providerSettingsService
                .savePersonalProviderOverlay(
                  binding.providerId,
                  {
                    api: updateApiConfig,
                    access: accessConfig,
                    personalModelIds: mergedModels,
                    modelOrder: mergedModels,
                  },
                  { enabled: siteEnabled && key.status === "active" },
                )
                .then(() => true)
                .catch(() => false);
              if (!overlayOk) {
                // 绑定的供应商已被外部删除——降级重建并更新绑定。
                const created = await deps.providerSettingsService.createPersonalProvider({
                  providerName: providerLabelFor(key.name),
                  initialConfig: {
                    personalModelIds: allModels,
                    modelOrder: allModels,
                  },
                });
                await deps.providerSettingsService.savePersonalProviderOverlay(
                  created.providerId,
                  {
                    api: apiConfig,
                    access: accessConfig,
                    personalModelIds: allModels,
                    modelOrder: allModels,
                  },
                  { enabled: siteEnabled && key.status === "active" },
                );
                binding.providerId = created.providerId;
              }
              for (const modelId of allModels) {
                const override = config.modelConfigs[modelConfigKey(site.id, key.id, modelId)];
                try {
                  // 智能配置（用户需求 2026-09-24）：新模型随推荐配置快照落盘；已存在模型
                  // 仅当个人配置为空（历史同步未落推荐、用户也未手动改过）时补写快照，
                  // 用户配置过的条目不覆盖。
                  const recommendation = override
                    ? null
                    : await resolveModelRecommendation(modelId, updateApiConfig.type);
                  const configPayload = override
                    ? buildModelConfig(override)
                    : (recommendation ?? {});
                  const existing = existingModelEntries.get(modelId);
                  if (!existing) {
                    await deps.providerSettingsService.addPersonalModel(
                      binding.providerId,
                      modelId,
                      configPayload,
                      true,
                    );
                    continue;
                  }
                  const personalExact = existing.personalExactConfig as
                    | Record<string, unknown>
                    | undefined;
                  const personalEmpty =
                    !personalExact ||
                    Object.keys(personalExact).every((field) => field === "enabled");
                  if (recommendation && personalEmpty) {
                    // savePersonalModelDraft 以 revision 防并发覆盖：逐模型取最新视图，
                    // 冲突（其他写入竞态）时本轮跳过，下次同步重试。
                    const view = await deps.providerSettingsService.getView();
                    await deps.providerSettingsService.savePersonalModelDraft({
                      providerId: binding.providerId,
                      originalModelId: modelId,
                      nextModelId: modelId,
                      personalConfig: recommendation,
                      useRecommendedConfig: true,
                      basedOnRevision: view.revision,
                    });
                  }
                } catch {
                  // 同上：单模型失败不中断。
                }
              }
            }
          } catch {
            // 单个密钥同步失败（名称冲突/网络等）不中断整体循环；已完成的绑定照常保存，
            // 避免半途中断导致 bindings 丢失、已建供应商泄漏到自定义分组。
          }
        }

        site.providerBindings = effectiveBindings;
        // 结构性变更（新增/删除供应商）需要广播，让模型选择器与导航即时刷新。
        await saveConfig({ ...config, sites: config.sites });
        return toSiteState(site);
      };
      const promise = run().finally(() => syncInFlight.delete(siteId));
      syncInFlight.set(siteId, promise);
      return promise;
    },
    async getModelConfig(siteId, keyId, model) {
      const config = await loadConfig();
      return config.modelConfigs[modelConfigKey(siteId, keyId, model)] ?? {};
    },
    async setModelConfig(siteId, keyId, model, override) {
      const config = await loadConfig();
      config.modelConfigs[modelConfigKey(siteId, keyId, model)] = override;
      await saveConfig({ ...config, sites: config.sites });
    },
  };

  // 返回代理而非 raw service：外部（RPC/UI）调用写方法时整体排队；闭包内部的
  // service.xxx 自调用仍指向 raw 对象，在调用方已持有的队列槽内继续执行，不重入。
  return new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof prop === "string" && configWriteMethods.has(prop) && typeof value === "function") {
        const method = value as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]): Promise<unknown> =>
          withConfigLock(() => method.apply(target, args));
      }
      return value;
    },
  });
}
