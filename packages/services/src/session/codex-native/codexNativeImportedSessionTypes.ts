import type { ZCodePersistedMessage } from "@zcode/shared";

/** 导入来源身份：外部原生 CLI（OpenAI Codex CLI），与 agent runtime 的 ZCodeProvider 无关。 */
export type CodexNativeImportSourceProvider = "codex";

export interface CodexNativeImportedSessionSource {
  provider: CodexNativeImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  migrationSource?: "codex";
  messages: ZCodePersistedMessage[];
}
