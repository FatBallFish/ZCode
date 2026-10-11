import { stat } from "node:fs/promises";
import {
  isObjectRecord,
  readTrimmedString,
  type JsonLineRecord,
} from "#src/session/claude-native/jsonLineRecord.js";
import { readJsonLinesFile } from "#src/session/claude-native/sessionHistoryJsonl.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { CodexNativeImportedSessionSource } from "#src/session/codex-native/codexNativeImportedSessionTypes.js";

/**
 * Codex CLI rollout（~/.codex/sessions 下按日期分层的 rollout-*.jsonl）解析。
 *
 * 每行结构：`{ timestamp, type, payload }`。与导入相关的 type：
 * - `session_meta`：payload.id/timestamp/cwd（session 归属 workspace 的唯一可信来源）；
 * - `turn_context`：payload.cwd/model（每轮上下文，model 取最后一次出现）；
 * - `response_item`：payload.type="message" 且 role=user/assistant 是可见对话；
 *   reasoning/function_call 等其余 payload 与 `event_msg`（重复播报）全部忽略。
 *
 * Codex 会把 <user_instructions>/<environment_context>/<turn_context> 等 SDK 注入内容
 * 也写成 user 消息；导入必须剔除，否则迁移后的会话正文失真。
 */

const CODEX_INJECTED_USER_TEXT_TAG_NAMES = new Set([
  "user_instructions",
  "environment_context",
  "turn_context",
  "environment_reminder",
  "permissions_update",
  "user_shell_context",
]);

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readRecordTimestamp(record: JsonLineRecord): number | undefined {
  return toTimestampMs(record.timestamp);
}

function getResponseItemPayload(record: JsonLineRecord): Record<string, unknown> | undefined {
  if (record.type !== "response_item") {
    return undefined;
  }
  return isObjectRecord(record.payload) ? record.payload : undefined;
}

function isInjectedCodexUserText(text: string): boolean {
  const trimmed = text.trim();
  // SDK 注入内容是单个完整的 <tag>…</tag> 块；用户真实输入不会被整段包裹在这些标签里。
  const match = /^<([a-z_]+)>[\s\S]*<\/([a-z_]+)>$/u.exec(trimmed);
  if (!match || match[1] !== match[2]) {
    return false;
  }
  return CODEX_INJECTED_USER_TEXT_TAG_NAMES.has(match[1]!);
}

function extractMessageTexts(payload: Record<string, unknown>): string[] {
  if (payload.type !== "message" || !Array.isArray(payload.content)) {
    return [];
  }

  const texts: string[] = [];
  for (const item of payload.content) {
    if (!isObjectRecord(item)) {
      continue;
    }
    const text = readTrimmedString(item.text);
    if (!text) {
      continue;
    }
    // input_text/output_text 是 Codex message content 的两种承载；旧版本直接用 text 字段。
    if (item.type !== "input_text" && item.type !== "output_text" && item.type !== "text") {
      continue;
    }
    texts.push(text);
  }
  return texts;
}

function extractCodexUserText(record: JsonLineRecord): string | null {
  const payload = getResponseItemPayload(record);
  if (!payload || payload.role !== "user") {
    return null;
  }

  const parts = extractMessageTexts(payload)
    .flatMap((text) => text.split(/\n\s*\n/u))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !isInjectedCodexUserText(part));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractCodexAssistantText(record: JsonLineRecord): string | null {
  const payload = getResponseItemPayload(record);
  if (!payload || payload.role !== "assistant") {
    return null;
  }

  const text = extractMessageTexts(payload).join("").trim();
  return text.length > 0 ? text : null;
}

function readCodexSessionMeta(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  createdAt?: number;
} {
  for (const entry of entries) {
    if (entry.type !== "session_meta" || !isObjectRecord(entry.payload)) {
      continue;
    }
    return {
      workspacePath: readTrimmedString(entry.payload.cwd),
      createdAt: toTimestampMs(entry.payload.timestamp) ?? toTimestampMs(entry.timestamp),
    };
  }
  return {};
}

function readCodexTurnContext(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  model?: string;
} {
  let workspacePath: string | undefined;
  let model: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "turn_context" || !isObjectRecord(entry.payload)) {
      continue;
    }
    workspacePath ??= readTrimmedString(entry.payload.cwd);
    model ??= readTrimmedString(entry.payload.model);
  }
  return { workspacePath, model };
}

export function extractCodexNativeSessionHeadInfo(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  previewTitle?: string;
  createdAt?: number;
} {
  const meta = readCodexSessionMeta(entries);
  const turnContext = readCodexTurnContext(entries);
  const workspacePath = meta.workspacePath ?? turnContext.workspacePath;

  for (const entry of entries) {
    const userText = extractCodexUserText(entry);
    if (!userText) {
      continue;
    }
    return {
      workspacePath,
      previewTitle: deriveSessionTitle(userText, []),
      // createdAt 优先取首条可见 user 消息时间（与 Claude 扫描一致），session_meta 兜底。
      createdAt: readRecordTimestamp(entry) ?? meta.createdAt,
    };
  }

  return { workspacePath, createdAt: meta.createdAt };
}

export async function parseCodexNativeSessionFile(params: {
  filePath: string;
  workspacePath: string;
  sessionId: string;
  sourcePath?: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<CodexNativeImportedSessionSource> {
  const [records, sourceStat] = await Promise.all([
    readJsonLinesFile(params.filePath),
    stat(params.filePath),
  ]);

  const meta = readCodexSessionMeta(records);
  const turnContext = readCodexTurnContext(records);
  const detectedWorkspacePath = meta.workspacePath ?? turnContext.workspacePath;
  const messages: CodexNativeImportedSessionSource["messages"] = [];
  let firstUserTimestamp: number | undefined;
  let updatedAt = params.fallbackUpdatedAt ?? Math.trunc(sourceStat.mtimeMs);
  let currentTurnIndex = -1;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;

  // 与 Claude 导入相同的最小可渲染结构：一轮用户输入聚合一段 assistant 回复；
  // Codex 的流式拆条在下一条 user turn 或文件结束时统一收口。
  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }
    messages.push({
      role: "assistant",
      content: pendingAssistantContent,
      timestamp: pendingAssistantTimestamp ?? updatedAt ?? Date.now(),
      turnIndex: currentTurnIndex,
    });
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
    pendingAssistantContent = "";
    pendingAssistantTimestamp = undefined;
  };

  for (const record of records) {
    const userText = extractCodexUserText(record);
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
      const timestamp = readRecordTimestamp(record) ?? updatedAt ?? Date.now();
      firstUserTimestamp ??= timestamp;
      updatedAt = timestamp;
      messages.push({
        role: "user",
        content: userText,
        timestamp,
        turnIndex: currentTurnIndex,
      });
      continue;
    }

    const assistantText = extractCodexAssistantText(record);
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }
    pendingAssistantContent += assistantText;
    pendingAssistantTimestamp =
      readRecordTimestamp(record) ?? pendingAssistantTimestamp ?? updatedAt;
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
  }

  flushPendingAssistant();

  if (messages.length === 0) {
    throw new Error(`[codex-native] Codex 原生 session ${params.sessionId} 没有可导入的可见消息`);
  }

  const createdAt =
    firstUserTimestamp ?? meta.createdAt ?? params.fallbackCreatedAt ?? updatedAt ?? Date.now();

  return {
    provider: "codex",
    sessionId: params.sessionId,
    workspacePath: detectedWorkspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath ?? params.filePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt ?? createdAt),
    title: deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []),
    // 单独写 migrationSource，任务列表/统计才能稳定识别迁移来源（与 claudeCode 同理）。
    migrationSource: "codex",
    ...(turnContext.model ? { model: turnContext.model } : {}),
    messages,
  };
}
