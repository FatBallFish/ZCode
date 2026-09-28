import { fetchMikikoBuiltinConfigRelease } from "@zcode/provider-node";
import { resolveMikikoBuiltinConfigUrl, type ApiClient } from "@zcode/shared";
import type { ZCodeBuiltinRelease } from "@zcode/provider-node";

interface FetchMikikoBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly signal?: AbortSignal;
}

/**
 * Mikiko 自建模型预置规则拉取（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.2）。
 * URL 解析在 shared（MIKIKO_BUILTIN_CONFIG_URL，默认 agent.mikiko.ai）；下载与 Release
 * 校验边界在 provider-node。URL 为 null（显式 disabled/off）时返回 null，远端同步器
 * 按「无远端」处理——离线/E2E 环境可彻底关闭出网刷新。
 */
export async function fetchMikikoBuiltinRemoteRelease(
  options: FetchMikikoBuiltinRemoteReleaseOptions,
): Promise<ZCodeBuiltinRelease | null> {
  const url = resolveMikikoBuiltinConfigUrl();
  if (url === null) {
    return null;
  }
  return fetchMikikoBuiltinConfigRelease({
    url,
    signal: options.signal,
    request: (requestUrl, init) => options.apiClient.request(requestUrl, init),
  });
}
