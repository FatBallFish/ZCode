import type { ZCodeEnv } from "./env.js";

export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";

/**
 * Mikiko 自建升级服务（spec specs/update/update-service.md）：manifest 与强更配置端点。
 * 与 DEFAULT_ZCODE_ENDPOINT_ORIGIN 分离——后者仍承载账号等既有后端能力。
 */
export const MIKIKO_UPDATE_ENDPOINT_ORIGIN = "https://agent-update.mikiko.ai";
export const MIKIKO_UPDATE_DOWNLOAD_ORIGIN = "https://agent-dl.mikiko.ai";
export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";

/**
 * Mikiko 自建云端（spec specs/mikiko-cloud/agent-endpoint-plan.md）：模型预置规则与功能配置。
 * 与 ZCode 官方端点分离——官方 client/configs 仍承载 Zai/CodingPlan 数据，此处只下发自管配置。
 */
export const DEFAULT_MIKIKO_CLOUD_ORIGIN = "https://agent.mikiko.ai";
export const DEFAULT_MIKIKO_BUILTIN_CONFIG_URL = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1/builtin-provider-config`;
export const DEFAULT_MIKIKO_CLIENT_CONFIG_URL = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1/client/configs`;
export const DEFAULT_MIKIKO_SHARE_API_BASE = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1`;
export const DEFAULT_MIKIKO_SHARE_WEB_URL = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/cn/share`;

export interface RuntimeMikikoCloudEnv {
  [key: string]: string | undefined;
  MIKIKO_BUILTIN_CONFIG_URL?: string;
  MIKIKO_CLIENT_CONFIG_URL?: string;
  MIKIKO_SHARE_API_BASE?: string;
  MIKIKO_SHARE_WEB_URL?: string;
}

/**
 * 解析自建模型预置规则 URL。显式 "disabled"/"off" 返回 null（离线/测试环境跳过远端刷新），
 * 未设置或空串回落默认地址——与构建注入 pickProductEndpointEnv 过滤空值的语义保持一致。
 */
export function resolveMikikoBuiltinConfigUrl(
  env: RuntimeMikikoCloudEnv = readProductEndpointEnv(),
): string | null {
  return resolveMikikoCloudUrl(env.MIKIKO_BUILTIN_CONFIG_URL, DEFAULT_MIKIKO_BUILTIN_CONFIG_URL);
}

/** 解析自建功能配置（dynamicWorkflow 灰度、分享限流）URL；禁用语义同上。 */
export function resolveMikikoClientConfigUrl(
  env: RuntimeMikikoCloudEnv = readProductEndpointEnv(),
): string | null {
  return resolveMikikoCloudUrl(env.MIKIKO_CLIENT_CONFIG_URL, DEFAULT_MIKIKO_CLIENT_CONFIG_URL);
}

/** 自建对话分享 API base（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.3）。 */
export function resolveMikikoShareApiBase(
  env: RuntimeMikikoCloudEnv = readProductEndpointEnv(),
): string | null {
  return resolveMikikoCloudUrl(env.MIKIKO_SHARE_API_BASE, DEFAULT_MIKIKO_SHARE_API_BASE);
}

/** 自建分享落地页前缀（无尾斜杠；拼接 code 时由调用方补 /）。 */
export function resolveMikikoShareWebUrl(
  env: RuntimeMikikoCloudEnv = readProductEndpointEnv(),
): string | null {
  return resolveMikikoCloudUrl(env.MIKIKO_SHARE_WEB_URL, DEFAULT_MIKIKO_SHARE_WEB_URL);
}

function resolveMikikoCloudUrl(raw: string | undefined, defaultUrl: string): string | null {
  const value = raw?.trim();
  if (value === undefined || value === "") {
    return defaultUrl;
  }
  const lowered = value.toLowerCase();
  if (lowered === "disabled" || lowered === "off") {
    return null;
  }
  return value;
}

// 构建仅注入公开链接；Node 调用方仍可显式传 env，避免读取另一进程的配置。
declare const __ZCODE_ENDPOINT_ENV__: Record<string, string | undefined> | undefined;
export function pickProductEndpointEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const keys = [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "MIKIKO_BASE_URL",
    "MIKIKO_ENDPOINT_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_CLIENT_ID",
    "ZAI_OAUTH_APP_ID",
    "MIKIKO_BUILTIN_CONFIG_URL",
    "MIKIKO_CLIENT_CONFIG_URL",
    "MIKIKO_SHARE_API_BASE",
    "MIKIKO_SHARE_WEB_URL",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (env[key]?.trim() ? [[key, env[key]!.trim()]] : [])),
  );
}
export function readProductEndpointEnv(): Record<string, string | undefined> {
  return {
    ...(typeof __ZCODE_ENDPOINT_ENV__ === "undefined" ? {} : __ZCODE_ENDPOINT_ENV__),
    ...pickProductEndpointEnv(typeof process === "undefined" ? {} : process.env),
  };
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  webShareCallbackUrl: string;
  zcodePlanOpenAiBaseUrl: string;
  zcodePlanAnthropicBaseUrl: string;
  zcodePlanBillingCurrentUrl: string;
  zcodePlanBillingBalanceUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZCODE_BASE_URL?: string;
  ZCODE_ENDPOINT_ORIGIN?: string;
  /** MIKIKO_ 前缀优先于 ZCODE_ 旧名（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.5）。 */
  MIKIKO_BASE_URL?: string;
  MIKIKO_ENDPOINT_ORIGIN?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_OAUTH_APP_ID?: string;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeZCodeEndpointEnv, RuntimeBigModelApiEnv, RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  zcodeEnv: ZCodeEnv;
  zcodeEndpointOrigin: string;
  zcodeEndpointUrls: ZCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ZCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isTrustedCodingPlanWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeZCodeEndpointOrigin(value);
    if (
      origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN ||
      origin === resolveRuntimeZCodeEndpointOrigin()
    ) {
      return true;
    }
    const parsed = new URL(origin);
    return options?.e2eStoreBridgeEnabled === true && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const origin = options?.overrideOrigin?.trim() || options?.envBaseOrigin?.trim();
  return origin ? normalizeZCodeEndpointOrigin(origin) : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
}

export function resolveRuntimeZCodeEnv(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEnv {
  // 产品身份仅用于既有展示与安装标识，不参与地址解析。
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  options?: { overrideOrigin?: string | null },
): string {
  return resolveZCodeEndpointOrigin({
    // MIKIKO_ 前缀优先（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.5 渐进迁移），
    // ZCODE_ 旧名回退兼容一个版本期。
    envBaseOrigin:
      readRuntimeEnvValue(env, "MIKIKO_BASE_URL") ??
      readRuntimeEnvValue(env, "MIKIKO_ENDPOINT_ORIGIN") ??
      readRuntimeEnvValue(env, "ZCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "ZCODE_ENDPOINT_ORIGIN"),
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env));
}

export function buildRuntimeZCodeApiUrl(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeZCodeEndpointOrigin(env)}${normalizedPath}`;
}

export function resolveBigModelApiOrigin(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ?? DEFAULT_BIGMODEL_API_ORIGIN,
  );
}

export function buildBigModelApiUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function buildBigModelCodingPlanPersonalManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  // 管理页与业务 API 共用显式 origin，避免把已登录账号带到另一个部署。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? DEFAULT_ZAI_OAUTH_ORIGIN,
  );
}

export function resolveZaiBusinessBaseUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ?? DEFAULT_ZAI_BUSINESS_BASE_URL,
  );
}

export function resolveZaiOAuthClientId(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    DEFAULT_ZAI_OAUTH_CLIENT_ID
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeZCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = readProductEndpointEnv(),
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

export function buildZCodeEndpointUrls(origin: string): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeZCodeEndpointOrigin(origin);
  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    zcodePlanOpenAiBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan`,
    zcodePlanAnthropicBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan/anthropic`,
    zcodePlanBillingCurrentUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/current`,
    zcodePlanBillingBalanceUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/balance`,
  };
}

export function rewriteZCodeEndpointUrl(input: string | URL, endpointOrigin: string): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  const sourceOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  if (parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}
