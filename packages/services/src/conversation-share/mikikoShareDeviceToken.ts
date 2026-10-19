import { createHash } from "node:crypto";
import { resolveMikikoFeedbackApiBase, resolveMikikoShareApiBase, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { ensureTelemetryDeviceMid } from "../telemetry/telemetryCore.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * Mikiko 自建云端的设备级凭据（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.3、
 * specs/mikiko-cloud/feedback-tickets.md）。
 *
 * 设备标识复用 deviceMid（唯一持久化所有者 device/deviceMid.ts），但只把 sha256(deviceMid)
 * 上送注册——原始设备标识不出网。token 由自建服务端签发（shares 与 feedback 共用同一
 * 注册端点与校验逻辑），本地经 credentialService 持久化，进程内缓存避免每次请求都读凭据；
 * 注册失败返回 null（调用链得到 401 语义的失败）。
 *
 * 2026-10-19 参数化：feedback 复用同一注册协议但独立凭据键与缓存，分享源被显式禁用
 * （disabled）不影响反馈链路注册。
 */

const SHARE_CREDENTIAL_KEY = "mikiko-share:device-token";
const FEEDBACK_CREDENTIAL_KEY = "mikiko-feedback:device-token";
const log = createServiceLogger("mikiko-cloud-device");

interface DeviceTokenCache {
  token: string | null;
  request: Promise<string | null> | null;
}

const caches = new Map<string, DeviceTokenCache>();

function getCache(credentialKey: string): DeviceTokenCache {
  let cache = caches.get(credentialKey);
  if (!cache) {
    cache = { token: null, request: null };
    caches.set(credentialKey, cache);
  }
  return cache;
}

async function resolveDeviceToken(options: {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load" | "save">;
  registerUrl: string;
  credentialKey: string;
  homeDir?: string;
}): Promise<string | null> {
  const cache = getCache(options.credentialKey);
  if (cache.token) return cache.token;
  if (cache.request) return cache.request;
  cache.request = (async () => {
    const stored = await options.credentialService.load(options.credentialKey);
    if (stored?.trim()) {
      cache.token = stored.trim();
      return cache.token;
    }
    const deviceMid = await ensureTelemetryDeviceMid(options.homeDir ? { homeDir: options.homeDir } : {});
    const deviceId = createHash("sha256").update(deviceMid).digest("hex");
    const response = await options.apiClient.request(options.registerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
      credentials: "omit",
      timeoutMs: 15_000,
    });
    if (!response.ok) {
      throw new Error(`Mikiko cloud device register HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as {
      code?: number;
      data?: { device_token?: unknown };
    };
    const token = envelope.data?.device_token;
    if (envelope.code !== 0 || typeof token !== "string" || !token.trim()) {
      throw new Error("Mikiko cloud device register invalid response");
    }
    cache.token = token.trim();
    await options.credentialService.save(options.credentialKey, cache.token);
    return cache.token;
  })();
  try {
    return await cache.request;
  } catch (error) {
    // 注册失败不缓存失败态（review S7）：下次请求重试注册；失败必须有服务日志可检索。
    log.warn(undefined, "Mikiko 云端设备 token 注册失败，本次请求将无凭据", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    cache.request = null;
  }
}

export interface MikikoCloudDeviceTokenOptions {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load" | "save">;
  homeDir?: string;
}

/** 分享发布链路的设备 token（register 走分享 API base）。 */
export async function resolveMikikoShareDeviceToken(
  options: MikikoCloudDeviceTokenOptions,
): Promise<string | null> {
  const shareApiBase = resolveMikikoShareApiBase();
  if (!shareApiBase) {
    // 显式禁用自建分享源：无 token，发布在鉴权处失败，公开读不受影响。
    return null;
  }
  return resolveDeviceToken({
    apiClient: options.apiClient,
    credentialService: options.credentialService,
    homeDir: options.homeDir,
    registerUrl: `${shareApiBase}/shares/device/register`,
    credentialKey: SHARE_CREDENTIAL_KEY,
  });
}

/** Bug 上报链路的设备 token（register 走反馈 API base，独立凭据键与缓存）。 */
export async function resolveMikikoFeedbackDeviceToken(
  options: MikikoCloudDeviceTokenOptions,
): Promise<string | null> {
  const feedbackApiBase = resolveMikikoFeedbackApiBase();
  if (!feedbackApiBase) {
    return null;
  }
  return resolveDeviceToken({
    apiClient: options.apiClient,
    credentialService: options.credentialService,
    homeDir: options.homeDir,
    registerUrl: `${feedbackApiBase}/shares/device/register`,
    credentialKey: FEEDBACK_CREDENTIAL_KEY,
  });
}

function resetCache(credentialKey: string): void {
  const cache = getCache(credentialKey);
  cache.token = null;
  cache.request = null;
}

/** 测试与凭据吊销后的强制重取入口。 */
export function resetMikikoShareDeviceTokenCache(): void {
  resetCache(SHARE_CREDENTIAL_KEY);
}

export function resetMikikoFeedbackDeviceTokenCache(): void {
  resetCache(FEEDBACK_CREDENTIAL_KEY);
}

/**
 * 3201 自愈（2026-09-28 分享全线 401 报障）：服务端历史版本曾以覆盖式单 secret
 * 注册，重注册会把本进程已持久化的 token 顶掉；凭据与进程缓存里的旧 token 从此
 * 永远无效。发布链路捕获 401/3201 后调用本入口——清缓存、删凭据、强制重新注册
 * 一次，返回新 token（失败返回 null 由调用方按原语义处理）。
 */
export async function invalidateAndReacquireMikikoShareDeviceToken(options: {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  homeDir?: string;
}): Promise<string | null> {
  resetCache(SHARE_CREDENTIAL_KEY);
  try {
    await options.credentialService.delete(SHARE_CREDENTIAL_KEY);
  } catch {
    // 凭据删除失败不阻断重注册：新 token 落盘时会覆盖旧值。
  }
  return resolveMikikoShareDeviceToken(options);
}

/** 反馈链路同款 401 自愈（specs/mikiko-cloud/feedback-tickets.md）。 */
export async function invalidateAndReacquireMikikoFeedbackDeviceToken(options: {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  homeDir?: string;
}): Promise<string | null> {
  resetCache(FEEDBACK_CREDENTIAL_KEY);
  try {
    await options.credentialService.delete(FEEDBACK_CREDENTIAL_KEY);
  } catch {
    // 凭据删除失败不阻断重注册：新 token 落盘时会覆盖旧值。
  }
  return resolveMikikoFeedbackDeviceToken(options);
}
