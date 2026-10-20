/** 原生 CLI 历史导入的适配器边界；session 执行事实始终由 CLI/runtime 创建。 */
export { importCodexNativeSessions } from "./codexNativeSessionImportService.js";
export { importClaudeNativeSessions } from "../claude-native/claudeNativeSessionImportService.js";
export type { CodexNativeImportedSessionSource } from "./codexNativeImportedSessionTypes.js";
export type { ClaudeNativeImportedSessionSource } from "../claude-native/claudeNativeImportedSessionTypes.js";
