import type {
  RemoteTarget,
  SourceServerProbeResult,
  SourceServerTransportAdapter,
} from "./contract.js";

/** 读取同一 adapter 的远端事实，不另起 backend、daemon 或 session。 */
export function inspectSourceServer(
  adapter: SourceServerTransportAdapter,
  target: RemoteTarget,
  signal?: AbortSignal,
): Promise<SourceServerProbeResult> {
  return adapter.probe(target, { signal }, { includeReleaseIdentity: true });
}
