/* eslint-disable max-lines -- 上游 v3.15.1 端点体系与 Mikiko 自建云端常量/解析合流后超限；两端点域职责内聚，拆分会割裂 resolve 链。 */
import type { ZCodeEnv } from "./env.js";

export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "https://agent.mikiko.ai";
export const TEST_ZCODE_ENDPOINT_ORIGIN = "https://agent.mikiko.ai";
export const CODING_PLAN_OFFICIAL_WEBVIEW_ORIGIN = "https://zcode.z.ai";
export const CODING_PLAN_LOCAL_WEBVIEW_ORIGIN = "http://localhost:3000";

/**
 * Mikiko 自建升级服务（spec specs/update/update-service.md）：manifest 与强更配置端点。
 * 与 DEFAULT_ZCODE_ENDPOINT_ORIGIN 分离——后者仍承载账号等既有后端能力。
 */
export const MIKIKO_UPDATE_ENDPOINT_ORIGIN = "https://agent-update.mikiko.ai";
export const MIKIKO_UPDATE_DOWNLOAD_ORIGIN = "https://agent-dl.mikiko.ai";
export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const TEST_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const TEST_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const TEST_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const TEST_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL = "wss://ws.mikiko.ai";
export const WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION = "3.4.0";

export interface BuildZCodeEndpointUrlsOptions {
  appVersion?: string;
  /** 账户测试/工厂的明确注入；普通产品域不能隐式决定官方账号来源。 */
  codingPlanOrigin?: string;
}

/**
 * Mikiko 自建云端（spec specs/mikiko-cloud/agent-endpoint-plan.md）：模型预置规则与功能配置。
 * 与 ZCode 官方端点分离——官方 client/configs 仍承载 Zai/CodingPlan 数据，此处只下发自管配置。
 */
export const DEFAULT_MIKIKO_CLOUD_ORIGIN = "https://agent.mikiko.ai";
export const DEFAULT_MIKIKO_BUILTIN_CONFIG_URL = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1/builtin-provider-config`;
export const DEFAULT_MIKIKO_CLIENT_CONFIG_URL = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1/client/configs`;
export const DEFAULT_MIKIKO_SHARE_API_BASE = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1`;
export const DEFAULT_MIKIKO_SHARE_WEB_URL = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/cn/share`;
export const DEFAULT_MIKIKO_FEEDBACK_API_BASE = `${DEFAULT_MIKIKO_CLOUD_ORIGIN}/api/v1`;

export interface RuntimeMikikoCloudEnv {
  [key: string]: string | undefined;
  MIKIKO_BUILTIN_CONFIG_URL?: string;
  MIKIKO_CLIENT_CONFIG_URL?: string;
  MIKIKO_SHARE_API_BASE?: string;
  MIKIKO_SHARE_WEB_URL?: string;
  MIKIKO_FEEDBACK_API_BASE?: string;
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

/**
 * 自建 Bug 上报 API base（specs/mikiko-cloud/feedback-tickets.md）。
 * 2026-10-19 起反馈彻底切换自建域名，不再出网 zcode.z.ai；禁用语义同上。
 */
export function resolveMikikoFeedbackApiBase(
  env: RuntimeMikikoCloudEnv = readProductEndpointEnv(),
): string | null {
  return resolveMikikoCloudUrl(env.MIKIKO_FEEDBACK_API_BASE, DEFAULT_MIKIKO_FEEDBACK_API_BASE);
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
    "MIKIKO_FEEDBACK_API_BASE",
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

function isWebRemoteControlV4AppVersion(appVersion: string | undefined): boolean {
  if (!appVersion) {
    return false;
  }

  // zcodeEndpoint 会被 Vite 配置在 Node 加载期直接导入，不能依赖源码态 `.js` runtime import。
  // 这里只比较固定的稳定版门槛；高于 3.4.0 的预发布版本仍满足门槛，3.4.0 自身的预发布版本不满足。
  const normalizedVersion = appVersion.trim().replace(/^v/i, "");
  const match = normalizedVersion.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([^+]+))?(?:\+(.+))?$/,
  );
  if (!match) {
    return false;
  }

  const prereleaseIdentifiers = match[4]?.split(".");
  const hasValidPrerelease =
    prereleaseIdentifiers === undefined ||
    prereleaseIdentifiers.every(
      (identifier) =>
        /^[0-9A-Za-z-]+$/.test(identifier) &&
        (!/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier)),
    );
  const buildIdentifiers = match[5]?.split(".");
  const hasValidBuild =
    buildIdentifiers === undefined ||
    buildIdentifiers.every((identifier) => /^[0-9A-Za-z-]+$/.test(identifier));
  if (!hasValidPrerelease || !hasValidBuild) {
    return false;
  }

  const versionParts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const floorParts = WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION.split(".").map(Number);
  for (let index = 0; index < floorParts.length; index += 1) {
    if (versionParts[index]! !== floorParts[index]!) {
      return versionParts[index]! > floorParts[index]!;
    }
  }

  return prereleaseIdentifiers === undefined;
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  remoteUrl: string;
  webRemoteCallbackUrl: string;
  webShareCallbackUrl: string;
  relayWsUrl: string;
  zcodePlanOpenAiBaseUrl: string;
  zcodePlanAnthropicBaseUrl: string;
  zcodePlanBillingCurrentUrl: string;
  zcodePlanBillingBalanceUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  MIKIKO_ENV?: string;
  /** MIKIKO_ 前缀（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.5）；ZCODE_ 旧名已移除读取。 */
  MIKIKO_BASE_URL?: string;
  MIKIKO_ENDPOINT_ORIGIN?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  MIKIKO_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
  BIGMODEL_TEST_API_BASE_URL?: string;
  BIGMODEL_PRODUCTION_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  MIKIKO_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_TEST_OAUTH_ORIGIN?: string;
  ZAI_PRODUCTION_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_TEST_BUSINESS_BASE_URL?: string;
  ZAI_PRODUCTION_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_TEST_OAUTH_CLIENT_ID?: string;
  ZAI_PRODUCTION_OAUTH_CLIENT_ID?: string;
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

function readRuntimeZCodeEnvScopedValue(
  env: Record<string, string | undefined>,
  zcodeEnv: ZCodeEnv,
  testKey: string,
  productionKey: string,
): string | undefined {
  return readRuntimeEnvValue(env, zcodeEnv === "production" ? productionKey : testKey);
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Mikiko endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Mikiko endpoint origin must use http or https");
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
      origin === CODING_PLAN_OFFICIAL_WEBVIEW_ORIGIN ||
      origin === CODING_PLAN_LOCAL_WEBVIEW_ORIGIN
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
  const env = options?.env ?? "test";
  // 旧产品默认值不能把普通云端服务带回官方；CodingPlan 由独立 resolver 保留官方例外。
  const productOrigin = (value: string) => {
    const origin = normalizeZCodeEndpointOrigin(value);
    return origin === CODING_PLAN_OFFICIAL_WEBVIEW_ORIGIN ? DEFAULT_MIKIKO_CLOUD_ORIGIN : origin;
  };
  const envBaseOrigin = options?.envBaseOrigin?.trim();
  if (env === "production") {
    return envBaseOrigin ? productOrigin(envBaseOrigin) : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  }

  const overrideOrigin = options?.overrideOrigin?.trim();
  if (overrideOrigin) {
    return productOrigin(overrideOrigin);
  }

  return envBaseOrigin ? productOrigin(envBaseOrigin) : TEST_ZCODE_ENDPOINT_ORIGIN;
}

export function resolveRuntimeZCodeEnv(env: RuntimeZCodeEndpointEnv = {}): ZCodeEnv {
  // 独立 CLI / 服务测试未注入 MIKIKO_ENV 时默认生产域；桌面测试包会显式下发 MIKIKO_ENV=test。
  // D6 双读窗口（specs/brand/surface-rebrand.md）：旧部署远端只下发 ZCODE_ENV 时兜底旧键，
  // 远端整体换代后连同 connect.ts 双转发一起删除。
  const rawEnv = env.MIKIKO_ENV ?? env.ZCODE_ENV;
  return rawEnv?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = {},
  options?: { overrideOrigin?: string | null },
): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);

  return resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    // MIKIKO_ 前缀（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.5）；ZCODE_ 旧名已移除读取。
    envBaseOrigin:
      readRuntimeEnvValue(env, "MIKIKO_BASE_URL") ??
      readRuntimeEnvValue(env, "MIKIKO_ENDPOINT_ORIGIN"),

    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = {},
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env), {
    codingPlanOrigin: resolveCodingPlanEndpointOrigin(env),
  });
}

export function buildRuntimeZCodeApiUrl(env: RuntimeZCodeEndpointEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeZCodeEndpointOrigin(env)}${normalizedPath}`;
}

export function resolveWebRemoteControlRelayWsUrl(options?: {
  endpointOrigin?: string | null | undefined;
  overrideUrl?: string | null | undefined;
}): string {
  const overrideUrl = options?.overrideUrl?.trim();
  if (overrideUrl) {
    return overrideUrl;
  }

  return buildZCodeEndpointUrls(options?.endpointOrigin?.trim() || DEFAULT_ZCODE_ENDPOINT_ORIGIN)
    .relayWsUrl;
}

export function resolveBigModelApiOrigin(env: RuntimeBigModelApiEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedBaseOrigin =
    zcodeEnv === "production"
      ? readRuntimeEnvValue(env, "BIGMODEL_PRODUCTION_API_BASE_URL")
      : readRuntimeEnvValue(env, "BIGMODEL_TEST_API_BASE_URL");
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_BIGMODEL_API_ORIGIN : TEST_BIGMODEL_API_ORIGIN;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ?? scopedBaseOrigin ?? fallbackOrigin,
  );
}

export function buildBigModelApiUrl(env: RuntimeBigModelApiEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function buildBigModelCodingPlanPersonalManageUrl(env: RuntimeBigModelApiEnv = {}): string {
  // 修复原因：BigModel Coding Plan 管理页要跟随 MIKIKO_ENV；
  // 测试环境如果继续写死 bigmodel.cn，会把测试账号带到生产套餐页。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(env: RuntimeBigModelApiEnv = {}): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedOrigin = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_OAUTH_ORIGIN",
    "ZAI_PRODUCTION_OAUTH_ORIGIN",
  );
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_ZAI_OAUTH_ORIGIN : TEST_ZAI_OAUTH_ORIGIN;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? scopedOrigin ?? fallbackOrigin,
  );
}

export function resolveZaiBusinessBaseUrl(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedOrigin = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_BUSINESS_BASE_URL",
    "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  );
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_ZAI_BUSINESS_BASE_URL : TEST_ZAI_BUSINESS_BASE_URL;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ?? scopedOrigin ?? fallbackOrigin,
  );
}

export function resolveZaiOAuthClientId(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedClientId = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_OAUTH_CLIENT_ID",
    "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  );
  const fallbackClientId =
    zcodeEnv === "production" ? DEFAULT_ZAI_OAUTH_CLIENT_ID : TEST_ZAI_OAUTH_CLIENT_ID;

  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    scopedClientId ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    fallbackClientId
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeZCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(env: RuntimeZaiEndpointEnv = {}, path: string): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(env: RuntimeZaiEndpointEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = {},
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin, {
      codingPlanOrigin: resolveCodingPlanEndpointOrigin(env),
    }),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

/** CodingPlan 是保留的官方账号业务；自建产品默认不能改写它的授权/计费来源。 */
export function resolveCodingPlanEndpointOrigin(env: RuntimeZCodeEndpointEnv = {}): string {
  const origin = resolveRuntimeZCodeEndpointOrigin(env);
  // 生产自建域不止默认域；只特判 agent.mikiko.ai 会向其他产品部署发送官方凭据。
  return resolveRuntimeZCodeEnv(env) === "test" && origin !== DEFAULT_MIKIKO_CLOUD_ORIGIN
    ? origin
    : CODING_PLAN_OFFICIAL_WEBVIEW_ORIGIN;
}

/** 仅官方 CodingPlan 账号/额度业务使用，普通产品 API 不走此入口。 */
export function buildRuntimeCodingPlanApiUrl(
  env: RuntimeZCodeEndpointEnv = {},
  path: string,
): string {
  return new URL(path, resolveCodingPlanEndpointOrigin(env)).toString();
}

export function buildZCodeEndpointUrls(
  origin: string,
  options: BuildZCodeEndpointUrlsOptions = {},
): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeZCodeEndpointOrigin(origin);
  const parsed = new URL(normalizedOrigin);
  const codingPlanOrigin =
    options.codingPlanOrigin === undefined
      ? ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
        ? normalizedOrigin
        : CODING_PLAN_OFFICIAL_WEBVIEW_ORIGIN
      : normalizeZCodeEndpointOrigin(options.codingPlanOrigin);
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const wsOrigin = `${wsProtocol}//${parsed.host}`;
  // 无法解析或低于分界版本时保守使用 v3，避免开发版本和旧客户端进入未兼容的 v4 页面。
  const remoteVersion = isWebRemoteControlV4AppVersion(options.appVersion) ? "v4" : "v3";

  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    remoteUrl: `${normalizedOrigin}/remote/${remoteVersion}`,
    webRemoteCallbackUrl: `${normalizedOrigin}/remote/v4`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    relayWsUrl:
      normalizedOrigin === DEFAULT_MIKIKO_CLOUD_ORIGIN
        ? DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL
        : `${wsOrigin}/ws`,
    zcodePlanOpenAiBaseUrl: `${codingPlanOrigin}/api/v1/zcode-plan`,
    zcodePlanAnthropicBaseUrl: `${codingPlanOrigin}/api/v1/zcode-plan/anthropic`,
    zcodePlanBillingCurrentUrl: `${codingPlanOrigin}/api/v1/zcode-plan/billing/current`,
    zcodePlanBillingBalanceUrl: `${codingPlanOrigin}/api/v1/zcode-plan/billing/balance`,
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
