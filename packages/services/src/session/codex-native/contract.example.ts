import type { importCodexNativeSessions } from "./contract.js";
export type CodexImportRequest = Parameters<typeof importCodexNativeSessions>[0];
/** 调用方注入原有 createImportedSession；不能直接写 CLI/session 事实或整行覆盖索引。 */
export async function importSelectedCodexHistory(
  importHistory: typeof importCodexNativeSessions,
  request: CodexImportRequest,
) {
  return importHistory(request);
}
