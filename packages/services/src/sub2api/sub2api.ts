import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Sub2API 中转站账号体系（v2：多站点）。
 *
 * 两类站点：MikikoCC（自有产品，内置面板/网关地址）与 Sub2api（用户自填 BaseURL，
 * 经 /api/v1/settings/public 校验后保存）。账密登录为一等公民（余额/订阅/密钥管理
 * 都依赖面板 JWT），API Key 直填为降级路径。站点开启 Turnstile 时由 UI 内嵌 widget
 * 取 token 后随 login 请求透传。
 */

export type Sub2ApiSiteKind = "mikikocc" | "sub2api";

export interface Sub2ApiAccountSummary {
  email: string;
  balanceUsd?: number;
  frozenUsd?: number;
  totalRechargedUsd?: number;
}

export interface Sub2ApiPublicSettings {
  siteName?: string;
  apiBaseUrl?: string;
  registrationEnabled?: boolean;
  turnstileEnabled: boolean;
  turnstileSiteKey?: string;
}

export interface Sub2ApiGroupInfo {
  id: number;
  name: string;
  platform?: string;
  description?: string;
  subscriptionType?: string;
}

export interface Sub2ApiKeyRecord {
  /** 面板密钥 id（数字转字符串）。 */
  id: string;
  name: string;
  /** 完整明文；面板列表即返回明文，UI 展示时自行打码。 */
  apiKey: string;
  status: string;
  groupId?: number | null;
  groupLabel?: string;
  platform?: string;
  quotaUsd?: number;
  quotaUsedUsd?: number;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  /** 本地补充：是否为该站点当前选中（用于网关调用投影）。 */
  active?: boolean;
}

export interface Sub2ApiSubscriptionWindow {
  window: "daily" | "weekly" | "monthly";
  usedUsd: number;
  limitUsd: number;
  resetAt?: string;
}

export interface Sub2ApiSubscriptionInfo {
  id: number;
  groupLabel: string;
  status: string;
  startsAt?: string;
  expiresAt?: string;
  windows: Sub2ApiSubscriptionWindow[];
}

export interface Sub2ApiProviderBinding {
  keyId: string;
  keyName: string;
  providerId: string;
}

export interface Sub2ApiSiteState {
  siteId: string;
  kind: Sub2ApiSiteKind;
  panelBaseUrl: string;
  gatewayBaseUrl: string;
  siteName?: string;
  account: Sub2ApiAccountSummary | null;
  keys: Sub2ApiKeyRecord[];
  activeKeyId?: string;
  providerId?: string;
  /** 每个密钥映射到的个人供应商（模型选择器分层展示的数据源）。 */
  providerBindings: Sub2ApiProviderBinding[];
  /** 本地离线模型清单：keyId → models。 */
  keyModels: Record<string, string[]>;
  /** 站点级启停（会话模型列表可见性）。 */
  enabled: boolean;
  /** 待绑定：等待用户填入站点地址的占位记录。 */
  pendingBind?: boolean;
}

export interface Sub2ApiSitesState {
  sites: Sub2ApiSiteState[];
}

export type Sub2ApiLoginErrorCode =
  | "captcha"
  | "captcha-not-configured"
  | "invalid-credential"
  | "requires-2fa"
  | "network"
  | "unknown";

export interface Sub2ApiLoginResult {
  state: Sub2ApiSiteState;
  syncedKeyCount: number;
}

export interface Sub2ApiAccountDetail {
  account: Sub2ApiAccountSummary;
  subscriptions: Sub2ApiSubscriptionInfo[];
  groups: Sub2ApiGroupInfo[];
}

export interface Sub2ApiUsagePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface Sub2ApiModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface Sub2ApiUsageSnapshot {
  siteId: string;
  range: "7d" | "30d";
  generatedAt: number;
  points: Sub2ApiUsagePoint[];
  models: Sub2ApiModelUsage[];
  totals: { requests: number; tokens: number; costUsd: number };
}

export interface Sub2ApiKeyUsage {
  status?: string;
  quotaRemainingUsd?: number;
  requestsToday?: number;
  models: string[];
}

export interface Sub2ApiKeyVerification {
  ok: boolean;
  modelCount: number;
  models: string[];
  errorCode?: "invalid-key" | "network" | "unknown";
  errorMessage?: string;
}

/** 按 站点-密钥-模型 维度保存在本地的模型配置覆盖。 */
export interface Sub2ApiModelConfigOverride {
  enabled?: boolean;
  contextWindow?: number;
  /** true = 用户手动添加的模型（网关清单之外），投影时并入供应商模型列表。 */
  custom?: boolean;
}

export interface ISub2ApiService {
  readonly onDidChange: Event<Sub2ApiSitesState>;
  getSites(): Promise<Sub2ApiSitesState>;
  getSiteState(siteId: string): Promise<Sub2ApiSiteState>;
  /** 校验 BaseURL 是 sub2api 服务（GET /api/v1/settings/public）并保存为站点。 */
  addSite(baseUrl: string): Promise<Sub2ApiSiteState>;
  /** 为待绑定站点（占位）填入真实地址并校验绑定。 */
  bindSiteAddress(siteId: string, baseUrl: string): Promise<Sub2ApiSiteState>;
  removeSite(siteId: string): Promise<Sub2ApiSitesState>;
  getPublicSettings(siteId: string): Promise<Sub2ApiPublicSettings>;
  login(request: {
    siteId: string;
    email: string;
    password: string;
    turnstileToken?: string;
  }): Promise<Sub2ApiLoginResult>;
  /** requires_2fa 后的二段登录。 */
  loginWith2FA(request: {
    siteId: string;
    tempToken: string;
    totpCode: string;
  }): Promise<Sub2ApiLoginResult>;
  logout(siteId: string): Promise<Sub2ApiSiteState>;
  /** 余额 + 订阅 + 分组一次拉全（登录态展示用）。 */
  getAccountDetail(siteId: string): Promise<Sub2ApiAccountDetail>;
  refreshAccount(siteId: string): Promise<Sub2ApiSiteState>;
  listKeys(siteId: string): Promise<Sub2ApiKeyRecord[]>;
  createKey(
    siteId: string,
    request: { name: string; groupId?: number | null },
  ): Promise<Sub2ApiKeyRecord>;
  updateKey(
    siteId: string,
    keyId: string,
    request: {
      name?: string;
      groupId?: number | null;
      status?: "active" | "inactive";
      quotaUsd?: number;
    },
  ): Promise<Sub2ApiKeyRecord>;
  deleteKey(siteId: string, keyId: string): Promise<Sub2ApiKeyRecord[]>;
  /** 激活密钥：投影为个人供应商（baseUrl/apiKey/模型清单），模型选择器即时可见。 */
  activateKey(siteId: string, keyId: string): Promise<Sub2ApiSiteState>;
  /** 网关面验证 Key（GET /v1/models），不落盘。 */
  verifyKey(siteId: string, apiKey: string): Promise<Sub2ApiKeyVerification>;
  refreshActiveKeyUsage(siteId: string): Promise<Sub2ApiKeyUsage | null>;
  /** 用量统计（dashboard trend + models）。 */
  getUsageSnapshot(siteId: string, range: "7d" | "30d"): Promise<Sub2ApiUsageSnapshot>;
  /** 为站点全部密钥同步个人供应商（每密钥一个，模型清单取本地离线数据）。 */
  syncProviders(siteId: string): Promise<Sub2ApiSiteState>;
  /** 站点级启停：关闭后该站点全部密钥供应商从会话模型列表隐藏。 */
  setSiteEnabled(siteId: string, enabled: boolean): Promise<Sub2ApiSiteState>;
  /** 从网关拉取密钥的模型清单并落本地（离线数据源）。 */
  refreshKeyModels(siteId: string, keyId: string): Promise<string[]>;
  getModelConfig(siteId: string, keyId: string, model: string): Promise<Sub2ApiModelConfigOverride>;
  setModelConfig(
    siteId: string,
    keyId: string,
    model: string,
    config: Sub2ApiModelConfigOverride,
  ): Promise<void>;
}

export const ISub2ApiService = createServiceDescriptor<ISub2ApiService>(ServiceChannels.Sub2Api);
