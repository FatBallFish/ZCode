import { createHash } from "node:crypto";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { generateTraceId } from "@zcode/shared";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { CodexNativeImportedSessionSource } from "#src/session/codex-native/codexNativeImportedSessionTypes.js";
import type { LegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";

export function buildImportedCodexTaskId(workspacePath: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(`codex:${workspacePath}:${sessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `codex-import-${digest}`;
}

function deriveImportedTaskTitle(
  fallbackTitle: string | undefined,
  messages: CodexNativeImportedSessionSource["messages"],
): string {
  const explicitTitle = fallbackTitle?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  return firstUserMessage ? deriveSessionTitle(firstUserMessage.content, []) : "Imported session";
}

/**
 * Codex 导入的最小 task snapshot（与 buildImportedClaudeTaskFile 同构）。
 * migrationSource 固定 "codex"：任务列表/统计按来源识别迁移历史，
 * 消息 ID 前缀（codex-import-）用于重导入时的旧消息清理。
 */
export function buildImportedCodexTaskFile(
  source: CodexNativeImportedSessionSource,
  taskIdOverride?: string,
): LegacyTaskSessionFile {
  if (source.messages.length === 0) {
    throw new Error(`[codex-native] external session ${source.sessionId} 没有可导入的可见消息`);
  }

  const taskId = taskIdOverride ?? buildImportedCodexTaskId(source.workspacePath, source.sessionId);
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : source.updatedAt;
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : createdAt;

  const meta: ZCodeTaskMeta = {
    taskId,
    traceId: generateTraceId(taskId),
    title: deriveImportedTaskTitle(source.title, source.messages),
    workspacePath: source.workspacePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    mode: "build",
    migrationSource: "codex",
    status: "completed",
    ...(source.model ? { model: source.model } : {}),
  };

  return {
    meta,
    messages: [...source.messages],
  };
}
