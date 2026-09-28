import { createHash } from "node:crypto";
import { resolveMikikoShareApiBase, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { ensureDeviceMid } from "../device/deviceMid.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * Mikiko 自建分享的设备级发布凭据（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.3）。
 *
 * 设备标识复用 deviceMid（唯一持久化所有者 device/deviceMid.ts），但只把 sha256(deviceMid)
 * 上送注册——原始设备标识不出网。token 由自建服务端签发，本地经 credentialService 持久化，
 * 进程内缓存避免每次发布都读凭据；注册失败返回 null（发布链路会得到 3201 语义的失败）。
 */

const CREDENTIAL_KEY = "mikiko-share:device-token";
const log = createServiceLogger("mikiko-share-device");

let cachedToken: string | null = null;
let cachedRequest: Promise<string | null> | null = null;

export async function resolveMikikoShareDeviceToken(options: {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load" | "save">;
  homeDir?: string;
}): Promise<string | null> {
  if (cachedToken) return cachedToken;
  if (cachedRequest) return cachedRequest;
  cachedRequest = (async () => {
    const stored = await options.credentialService.load(CREDENTIAL_KEY);
    if (stored?.trim()) {
      cachedToken = stored.trim();
      return cachedToken;
    }
    const shareApiBase = resolveMikikoShareApiBase();
    if (!shareApiBase) {
      // 显式禁用自建分享源：无 token，发布在鉴权处失败，公开读不受影响。
      return null;
    }
    const deviceMid = await ensureDeviceMid(options.homeDir ? { homeDir: options.homeDir } : {});
    const deviceId = createHash("sha256").update(deviceMid).digest("hex");
    const response = await options.apiClient.request(`${shareApiBase}/shares/device/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
      credentials: "omit",
      timeoutMs: 15_000,
    });
    if (!response.ok) {
      throw new Error(`Mikiko share device register HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as {
      code?: number;
      data?: { device_token?: unknown };
    };
    const token = envelope.data?.device_token;
    if (envelope.code !== 0 || typeof token !== "string" || !token.trim()) {
      throw new Error("Mikiko share device register invalid response");
    }
    cachedToken = token.trim();
    await options.credentialService.save(CREDENTIAL_KEY, cachedToken);
    return cachedToken;
  })();
  try {
    return await cachedRequest;
  } catch (error) {
    // 注册失败不缓存失败态（review S7）：下次发布重试注册；失败必须有服务日志可检索。
    log.warn(undefined, "Mikiko 分享设备 token 注册失败，本次发布将无凭据", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    cachedRequest = null;
  }
}

/** 测试与凭据吊销后的强制重取入口。 */
export function resetMikikoShareDeviceTokenCache(): void {
  cachedToken = null;
  cachedRequest = null;
}

/**
 * 3201 自愈（2026-09-28 分享全线 401 报障）：服务端历史版本曾以覆盖式单 secret
 * 注册，重注册会把本进程已持久化的 token 顶掉；凭据与进程缓存里的旧 token 从此
 * 永远无效。发布链路捕获 3201 后调用本入口——清缓存、删凭据、强制重新注册一次，
 * 返回新 token（失败返回 null 由调用方按原语义处理）。
 */
export async function invalidateAndReacquireMikikoShareDeviceToken(options: {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  homeDir?: string;
}): Promise<string | null> {
  resetMikikoShareDeviceTokenCache();
  try {
    await options.credentialService.delete(CREDENTIAL_KEY);
  } catch {
    // 凭据删除失败不阻断重注册：新 token 落盘时会覆盖旧值。
  }
  return resolveMikikoShareDeviceToken(options);
}
