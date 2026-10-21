import {
  ProviderEntryOrigins,
  isPresentedInput,
  projectIncomingMessageEntries,
} from "./provider-entry-origins.js";
import {
  projectMidConversationSystemEntries,
  moveLegacySystemRemindersAfterToolResultRun,
  isToolResultUserMessage,
  type ProjectedRuntimeMessageEntry,
} from "./provider-mid-conversation-system.js";
import type { ModelMessageContent, ModelMessageContentBlock } from "@zcode/contracts";
import type { ModelInputMessage, RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  cloneModelInputMessage,
  toModelToolCall,
  cloneModelMessageContent,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../../system-reminder/source.js";

export interface ProviderRequestMessageProjectionResult {
  messages: ModelInputMessage[];
  /** 仅用于内部归属；runtime metadata 不会进入 `messages`。 */
  sourceEntries: Array<RuntimeMessageEntry | undefined>;
  diagnostics: {
    bubbledAttachmentEntryCount: number;
    latestRealUserMessageIndex?: number;
    strippedRuntimeMetaCount: number;
    cacheControlIndex?: number;
  };
}

// 相邻 user 合并是 Anthropic provider 的协议序列化责任；
// MCS/provider projection 保持 provider-neutral，避免影响 OpenAI-compatible 请求形态。
const ENABLE_MCS_ADJACENT_USER_MERGE = false;
const TOOL_SEARCH_LOADED_MESSAGE = "Tool loaded.";

// State changes must keep their causal position relative to older target continuations.
const NON_BUBBLING_ATTACHMENT_SOURCES: ReadonlySet<SystemReminderSource> = new Set([
  "goal_state_change",
]);

export function buildProviderRequestMessages(input: {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  skipCacheWrite?: boolean;
  useMidConversationSystem?: boolean;
  loadedToolCallIds?: ReadonlySet<string>;
  /** anchored 布局：最后一条 system + 会话稳定附件 + 压缩摘要锚 + 最新消息，上限 4 个断点。 */
  cacheLayout?: "legacy" | "anchored";
}): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem = input.useMidConversationSystem !== false;
  const origins = new ProviderEntryOrigins();
  const reorderResult = reorderAttachmentLikeEntries(
    projectIncomingMessageEntries(input.entries, origins),
  );
  const midSystemProjection = useMidConversationSystem
    ? projectMidConversationSystemEntries(reorderResult.entries, origins)
    : { entries: reorderResult.entries };
  const projectedEntries = moveLegacySystemRemindersAfterToolResultRun(midSystemProjection.entries);
  // media-budget 在 provider-clean messages 上运行，必须在剥离 metadata 前记录
  // latest real user 的 projection 后索引，避免用户 literal system-reminder 被误当成 meta。
  const latestRealUserMessageIndex = findLatestRealUserEntryIndex(projectedEntries, origins);
  const renderedMessages = projectedEntries.map(renderProjectedEntryToModelMessage);
  const mergeResult = ENABLE_MCS_ADJACENT_USER_MERGE
    ? mergeAdjacentUserMessages(renderedMessages)
    : appendToolSearchSuccessMessages(renderedMessages, input.loadedToolCallIds);
  const messages = mergeResult.messages;
  const sourceEntries: Array<RuntimeMessageEntry | undefined> = Array.from({
    length: messages.length,
  });
  for (const [projectedIndex, mergedIndex] of mergeResult.indexMap.entries()) {
    if (sourceEntries[mergedIndex] !== undefined) continue;
    const entry = projectedEntries[projectedIndex];
    // representative 对纯附件条目返回 undefined；回填附件自身，
    // 让 anchored 断点布局能从 sourceEntries 识别 context_prefix/skills_listing。
    if (entry) sourceEntries[mergedIndex] = origins.representative(entry) ?? entry;
  }
  const finalLatestRealUserMessageIndex =
    latestRealUserMessageIndex >= 0 ? (mergeResult.indexMap[latestRealUserMessageIndex] ?? -1) : -1;
  const cacheControlIndex =
    input.applyCacheControl === true
      ? input.cacheLayout === "anchored"
        ? finalizeAnchoredCacheControl(messages, sourceEntries, {
            skipCacheWrite: input.skipCacheWrite === true,
          })
        : finalizeLatestNonSystemMessageCacheControl(messages, {
            skipCacheWrite: input.skipCacheWrite === true,
          })
      : undefined;

  return {
    messages,
    sourceEntries,
    diagnostics: {
      bubbledAttachmentEntryCount: reorderResult.bubbledAttachmentEntryCount,
      // 新标记能证明“没有真实用户”；省略索引会让媒体预算按 user role 重新猜来源。
      ...(finalLatestRealUserMessageIndex >= 0 ||
      input.entries.some(isPresentedInput) ||
      input.loadedToolCallIds?.size
        ? { latestRealUserMessageIndex: finalLatestRealUserMessageIndex }
        : {}),
      strippedRuntimeMetaCount: input.entries.filter((entry) => entry.metadata).length,
      ...(cacheControlIndex !== undefined ? { cacheControlIndex } : {}),
    },
  };
}

interface AttachmentReorderResult {
  entries: RuntimeMessageEntry[];
  bubbledAttachmentEntryCount: number;
}

function reorderAttachmentLikeEntries(
  entries: readonly RuntimeMessageEntry[],
): AttachmentReorderResult {
  const result: RuntimeMessageEntry[] = [];
  const pending: RuntimeMessageEntry[] = [];
  let bubbledAttachmentEntryCount = 0;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (isAttachmentLikeUserEntry(entry)) {
      pending.push(entry);
      continue;
    }

    if (
      (isPresentedInput(entry) ||
        (!isRuntimeAttachmentEntry(entry) && isBubbleStop(entry.message))) &&
      pending.length > 0
    ) {
      result.push(...pending);
      bubbledAttachmentEntryCount += pending.length;
      pending.length = 0;
    }
    result.push(entry);
  }

  if (pending.length > 0) {
    result.push(...pending);
    bubbledAttachmentEntryCount += pending.length;
  }

  result.reverse();
  return { entries: result, bubbledAttachmentEntryCount };
}

function isAttachmentLikeUserEntry(entry: RuntimeMessageEntry): boolean {
  if (isPresentedInput(entry)) return false;
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) return false;
    if (NON_BUBBLING_ATTACHMENT_SOURCES.has(source)) return false;
    const descriptor = getSystemReminderDescriptor(source);
    if (descriptor.channel === "history_continuity") return false;
    return (
      descriptor.isMeta &&
      descriptor.providerVisibility === "provider_visible" &&
      descriptor.channel !== "tool_result" &&
      descriptor.channel !== "real_user"
    );
  }

  if (entry.message.role !== "user") return false;
  if (isToolResultUserMessage(entry.message)) return false;
  const source = entry.metadata?.source;
  if (!source || source === "real_user") return false;
  if (source === "legacy_synthetic") return true;
  if (!isKnownSystemReminderSource(source)) return false;
  if (isMidConversationSystemSource(source)) return false;

  const descriptor = getSystemReminderDescriptor(source);
  if (descriptor.channel === "history_continuity") return false;
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "tool_result" &&
    descriptor.channel !== "real_user"
  );
}

function isBubbleStop(message: ModelInputMessage): boolean {
  return (
    message.role === "system" ||
    message.role === "assistant" ||
    message.role === "tool" ||
    isToolResultUserMessage(message)
  );
}

function renderProjectedEntryToModelMessage(
  entry: ProjectedRuntimeMessageEntry,
): ModelInputMessage {
  if (isRuntimeAttachmentEntry(entry)) {
    const source = entry.metadata.source;
    if (!isKnownSystemReminderSource(source)) {
      throw new Error(`Attachment source ${source} is not a system reminder source`);
    }
    const message: ModelInputMessage = {
      role: "user",
      // incoming 载荷也可能含关闭标签；统一在 provider 包装时转义，canonical 原文不变。
      content: wrapSystemReminderForSource(source, entry.content),
    };
    if (entry.cacheControl) {
      message.cacheControl = { ...entry.cacheControl };
    }
    return message;
  }
  const message = cloneModelInputMessage(entry.message);
  // 内部历史使用目标身份；只在现有 provider render 中恢复真实模型包装。
  for (let index = 0; index < (message.toolCalls?.length ?? 0); index++) {
    message.toolCalls![index] = toModelToolCall(message.toolCalls![index]!);
  }
  if (message.modelCallWrapper) {
    message.toolName = message.modelCallWrapper;
    delete message.modelCallWrapper;
  }
  return message;
}

interface MessageMergeResult {
  messages: ModelInputMessage[];
  indexMap: number[];
}

function mergeAdjacentUserMessages(messages: readonly ModelInputMessage[]): MessageMergeResult {
  const merged: ModelInputMessage[] = [];
  const indexMap: number[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const previous = merged.at(-1);
    if (previous && canMergeAdjacentUserMessages(previous, message)) {
      const mergedIndex = merged.length - 1;
      merged[mergedIndex] = mergeUserMessages(previous, message);
      indexMap[index] = mergedIndex;
      continue;
    }

    indexMap[index] = merged.length;
    merged.push(message);
  }

  return { messages: merged, indexMap };
}

function appendToolSearchSuccessMessages(
  messages: readonly ModelInputMessage[],
  loadedToolCallIds?: ReadonlySet<string>,
): MessageMergeResult {
  if (!loadedToolCallIds?.size)
    return { messages: [...messages], indexMap: messages.map((_, index) => index) };
  const result: ModelInputMessage[] = [];
  const indexMap: number[] = [];
  let pendingLoaded = 0;
  for (const [index, message] of messages.entries()) {
    indexMap.push(result.length);
    result.push(message);
    if (message.role === "tool" && message.toolCallId && loadedToolCallIds.has(message.toolCallId))
      pendingLoaded++;
    // 成功提示只在最终投影中派生；整批 tool result 必须连续，不能被提示拆开。
    if (messages[index + 1]?.role !== "tool") {
      while (pendingLoaded > 0) {
        result.push({ role: "user", content: TOOL_SEARCH_LOADED_MESSAGE });
        pendingLoaded--;
      }
    }
  }
  return { messages: result, indexMap };
}

function canMergeAdjacentUserMessages(
  previous: ModelInputMessage,
  next: ModelInputMessage,
): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  return !isToolResultUserMessage(previous) && !isToolResultUserMessage(next);
}

function mergeUserMessages(
  previous: ModelInputMessage,
  next: ModelInputMessage,
): ModelInputMessage {
  const merged: ModelInputMessage = {
    role: "user",
    content: mergeUserContent(previous.content, next.content),
  };
  const cacheControl = next.cacheControl ?? previous.cacheControl;
  if (cacheControl) merged.cacheControl = { ...cacheControl };
  return merged;
}

function mergeUserContent(
  previous: ModelMessageContent,
  next: ModelMessageContent,
): ModelMessageContentBlock[] {
  const previousBlocks = modelContentToMergeBlocks(previous);
  const nextBlocks = modelContentToMergeBlocks(next);
  const previousLast = previousBlocks.at(-1);
  const nextFirst = nextBlocks[0];

  if (previousLast?.type === "text" && nextFirst?.type === "text") {
    previousBlocks[previousBlocks.length - 1] = {
      ...previousLast,
      text: `${previousLast.text}\n`,
    };
  }

  return [...previousBlocks, ...nextBlocks];
}

function modelContentToMergeBlocks(content: ModelMessageContent): ModelMessageContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return cloneModelMessageContent(content) as ModelMessageContentBlock[];
}

function findLatestRealUserEntryIndex(
  entries: readonly ProjectedRuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): number {
  return entries.findLastIndex((entry) => origins.hasRealUser(entry));
}

function finalizeLatestNonSystemMessageCacheControl(
  messages: ModelInputMessage[],
  options: { skipCacheWrite?: boolean } = {},
): number | undefined {
  clearNonSystemMessageCacheControl(messages);

  const latestIndex = findPreviousNonSystemMessageIndex(messages, messages.length - 1);
  if (latestIndex === undefined) return undefined;

  // 但不作为 cache write breakpoint，marker 应前移到 compact prompt 前的真实上下文。
  const cacheControlIndex =
    options.skipCacheWrite === true
      ? findPreviousNonSystemMessageIndex(messages, latestIndex - 1)
      : latestIndex;
  if (cacheControlIndex === undefined) return undefined;

  const message = messages[cacheControlIndex]!;
  messages[cacheControlIndex] = {
    ...message,
    cacheControl: { type: "ephemeral" },
  };
  return cacheControlIndex;
}

function findPreviousNonSystemMessageIndex(
  messages: readonly ModelInputMessage[],
  startIndex: number,
): number | undefined {
  for (let index = Math.min(startIndex, messages.length - 1); index >= 0; index--) {
    if (messages[index]?.role !== "system") return index;
  }
  return undefined;
}

/**
 * anchored 断点布局（fused/deepseek/codex 预设）：
 * 1) 最后一条 system（覆盖 tools+全部 system，替代 legacy 的双 system 断点）；
 * 2) 最后一条会话稳定附件（context_prefix / skills_listing）——压缩后仍可整段命中；
 * 3) 最近一条压缩摘要消息——窗口内稳定锚；
 * 4) 最新非 system 消息（skipCacheWrite 时前移一位）。
 * 同一消息只保留一个断点，总断点数不超过 4（Anthropic cache_control 上限）。
 */
function finalizeAnchoredCacheControl(
  messages: ModelInputMessage[],
  sourceEntries: ReadonlyArray<RuntimeMessageEntry | undefined>,
  options: { skipCacheWrite?: boolean } = {},
): number | undefined {
  clearAllMessageCacheControl(messages);

  const anchorIndexes: number[] = [];
  const pushAnchor = (index: number | undefined) => {
    if (index === undefined || index < 0 || index >= messages.length) return;
    if (!anchorIndexes.includes(index) && anchorIndexes.length < 4) anchorIndexes.push(index);
  };

  let lastSystemIndex: number | undefined;
  let lastContextAttachmentIndex: number | undefined;
  let lastCompactSummaryIndex: number | undefined;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === "system") {
      lastSystemIndex = index;
      continue;
    }
    const entry = sourceEntries[index];
    if (!entry) continue;
    if (
      isRuntimeAttachmentEntry(entry) &&
      (entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing")
    ) {
      lastContextAttachmentIndex = index;
    }
    if (
      !isRuntimeAttachmentEntry(entry) &&
      entry.metadata &&
      "compactBoundary" in entry.metadata &&
      entry.metadata.compactBoundary !== undefined
    ) {
      lastCompactSummaryIndex = index;
    }
  }

  pushAnchor(lastSystemIndex);
  pushAnchor(lastContextAttachmentIndex);
  pushAnchor(lastCompactSummaryIndex);
  const latestIndex = findPreviousNonSystemMessageIndex(messages, messages.length - 1);
  if (options.skipCacheWrite === true && latestIndex !== undefined) {
    pushAnchor(findPreviousNonSystemMessageIndex(messages, latestIndex - 1));
  } else {
    pushAnchor(latestIndex);
  }

  for (const index of anchorIndexes) {
    messages[index] = { ...messages[index]!, cacheControl: { type: "ephemeral" } };
  }
  return latestIndex;
}

function clearAllMessageCacheControl(messages: ModelInputMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (!message.cacheControl) continue;
    const { cacheControl: _cacheControl, ...messageWithoutCacheControl } = message;
    messages[index] = messageWithoutCacheControl;
  }
}

function clearNonSystemMessageCacheControl(messages: ModelInputMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system" || !message.cacheControl) continue;
    const { cacheControl: _cacheControl, ...messageWithoutCacheControl } = message;
    messages[index] = messageWithoutCacheControl;
  }
}
