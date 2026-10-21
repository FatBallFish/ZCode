import {
  COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
  CompactTrigger,
  MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
  countContextPrefixMessages,
  estimateMessageTokens,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { CompactRetentionStrategy } from "../../compact/policy.js";
import {
  cloneRuntimeMessageEntry,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";
import { isToolResultUserMessage } from "./provider-mid-conversation-system.js";

/** fused 防连环压缩时在「阈值 − 前缀 − 摘要上限」之外留出的安全余量。 */
const RETENTION_CAP_MARGIN_TOKENS = 2_000;

interface CompactRetryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface CompactEntrySelection {
  entriesForSummary: RuntimeMessageEntry[];
  groupsPreserved: number;
  preservedEntries: RuntimeMessageEntry[];
  totalGroups: number;
}

export interface CompactRetentionInput {
  strategy: CompactRetentionStrategy;
  /** token 预算比例的分母；缺省用默认压缩窗口。 */
  effectiveContextWindow?: number;
  /** 压缩后总量上限（auto compact 阈值）；用于收缩保留预算防止下一轮连环压缩。 */
  totalCapTokens?: number;
  /** 摘要输出的最大 token 预留。 */
  summaryMaxTokens?: number;
  useMidConversationSystem?: boolean;
}

export function selectCompactEntries(input: {
  entries: readonly RuntimeMessageEntry[];
  minimumGroupsToPreserve?: number;
  retention?: CompactRetentionInput;
  trigger: CompactTrigger;
}): CompactEntrySelection {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (input.retention && input.retention.strategy.kind !== "legacy-groups") {
    return selectCompactEntriesWithRetention(split, input.retention);
  }
  const baseGroupsToPreserve = split.shouldPreserveRecent && split.groups.length > 1 ? 1 : 0;
  const requestedGroupsToPreserve = Math.max(
    baseGroupsToPreserve,
    positiveInt(input.minimumGroupsToPreserve) ?? 0,
  );
  const maxGroupsToPreserve = Math.max(0, split.groups.length - 1);
  const groupsToPreserve = split.shouldPreserveRecent
    ? Math.min(requestedGroupsToPreserve, maxGroupsToPreserve)
    : 0;
  const summaryGroups =
    groupsToPreserve > 0
      ? split.groups.slice(0, split.groups.length - groupsToPreserve)
      : split.groups;
  const preservedGroups = groupsToPreserve > 0 ? split.groups.slice(-groupsToPreserve) : [];

  return {
    entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
    groupsPreserved: groupsToPreserve,
    preservedEntries: preservedGroups.flat().map(cloneRuntimeEntry),
    totalGroups: split.groups.length,
  };
}

export function selectCompactEntriesAfterPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
  currentGroupsPreserved: number;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length < 2) {
    return null;
  }

  const maxGroupsToPreserve = split.groups.length - 1;
  if (input.currentGroupsPreserved >= maxGroupsToPreserve) {
    return null;
  }

  const summarizedGroupCount = split.groups.length - input.currentGroupsPreserved;
  const groupsForSummary = split.groups.slice(0, summarizedGroupCount);
  if (groupsForSummary.length < 2) {
    return null;
  }

  const groupsToMove = countRecentGroupsToPreserveAfterPromptTooLong(
    groupsForSummary,
    input.promptTooLongCause,
    { useMidConversationSystem: input.useMidConversationSystem },
  );
  const nextGroupsPreserved = Math.min(
    maxGroupsToPreserve,
    input.currentGroupsPreserved + groupsToMove,
  );
  if (nextGroupsPreserved <= input.currentGroupsPreserved) {
    return null;
  }

  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: nextGroupsPreserved,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function selectCompactEntriesForInitialPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length <= 3) {
    return null;
  }

  const tokenGap = getPromptTooLongTokenGap(input.promptTooLongCause);
  if (tokenGap === undefined) {
    return null;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(split.groups, {
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const alreadyPreservedTokens = groupTokenEstimates.at(-1) ?? 0;
  const remainingTokenGap = tokenGap - alreadyPreservedTokens;
  if (remainingTokenGap <= 0) {
    return null;
  }

  const additionalGroupsToPreserve = countRecentGroupsToCoverTokenGap(
    groupTokenEstimates,
    split.groups.length - 1,
    remainingTokenGap,
  );
  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: 1 + additionalGroupsToPreserve,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function getRuntimeEntriesToSummarize(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.filter((entry) => !isRuntimeContextPrefixEntry(entry)).map(cloneRuntimeEntry);
}

export function hasEnoughRuntimeEntriesToCompact(entries: readonly RuntimeMessageEntry[]): boolean {
  const entriesToSummarize = getRuntimeEntriesToSummarize(entries);
  return (
    groupRuntimeEntriesByCompactRound(entriesToSummarize).length >= 2 &&
    entriesToSummarize.some((entry) => runtimeEntryRole(entry) === "assistant")
  );
}

export function estimateRuntimeEntryTokens(
  entries: readonly RuntimeMessageEntry[],
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const providerMessages = buildProviderRequestMessages({
    entries,
    applyCacheControl: false,
    useMidConversationSystem: options.useMidConversationSystem,
  }).messages;
  return estimateMessageTokens(providerMessages);
}

export function truncateCompactSummaryRequestEntriesAfterPromptTooLong(options: {
  attempt: number;
  cause: unknown;
  entriesForSummary: readonly RuntimeMessageEntry[];
  logger?: CompactRetryLogger;
  traceContext: TraceContext;
  useMidConversationSystem?: boolean;
}): RuntimeMessageEntry[] | null {
  if (options.attempt >= MAX_COMPACT_PROMPT_TOO_LONG_RETRIES) {
    options.logger?.warn("Compact summary prompt was too long; retry limit reached", {
      ...traceContextToLogContext(options.traceContext),
      attempt: options.attempt,
      event: "compact.prompt_too_long.retry_limit",
      maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
      module: "core.runtime",
      remainingMessages: options.entriesForSummary.length,
    });
    return null;
  }

  const truncated = truncateRuntimeEntriesForCompactRetry(
    options.entriesForSummary,
    options.cause,
    { useMidConversationSystem: options.useMidConversationSystem },
  );
  if (!truncated) {
    return null;
  }

  options.logger?.warn("Compact summary prompt was too long; retrying with older rounds dropped", {
    ...traceContextToLogContext(options.traceContext),
    attempt: options.attempt + 1,
    droppedMessages: options.entriesForSummary.length - truncated.length,
    event: "compact.prompt_too_long.retry",
    maxAttempts: MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
    module: "core.runtime",
    remainingMessages: truncated.length,
  });

  return truncated;
}

function splitRuntimeEntriesForCompactSelection(
  inputEntries: readonly RuntimeMessageEntry[],
  trigger: CompactTrigger,
): {
  groups: RuntimeMessageEntry[][];
  prefixEntries: RuntimeMessageEntry[];
  shouldPreserveRecent: boolean;
} {
  const entries = inputEntries.map(cloneRuntimeEntry);
  const prefixCount = countContextPrefixMessages(entries);
  const prefixEntries = entries.slice(0, prefixCount);
  const bodyEntries = entries.slice(prefixCount);

  return {
    groups: groupRuntimeEntriesByCompactRound(bodyEntries),
    prefixEntries,
    shouldPreserveRecent: trigger === CompactTrigger.Auto || trigger === CompactTrigger.Reactive,
  };
}

/**
 * 预设驱动的保留选择。token-budget 按「尾部累计 ≥ 预算」保留完整轮组；
 * user-messages 只保留真实用户消息原文（对齐 Codex），其余全部进入摘要输入。
 */
function selectCompactEntriesWithRetention(
  split: ReturnType<typeof splitRuntimeEntriesForCompactSelection>,
  retention: CompactRetentionInput,
): CompactEntrySelection {
  const strategy = retention.strategy;
  if (split.groups.length <= 2) {
    // 摘要输入至少需要 2 个轮组；退化时保留策略不生效，交给调用方 skip。
    return {
      entriesForSummary: [...split.prefixEntries, ...split.groups.flat()].map(cloneRuntimeEntry),
      groupsPreserved: 0,
      preservedEntries: [],
      totalGroups: split.groups.length,
    };
  }

  if (strategy.kind === "token-budget") {
    let budgetTokens = Math.floor(
      strategy.ratio * (retention.effectiveContextWindow ?? DEFAULT_RETENTION_WINDOW_TOKENS),
    );
    if (retention.totalCapTokens !== undefined) {
      const prefixTokens = estimateRuntimeEntryTokens(split.prefixEntries, {
        useMidConversationSystem: retention.useMidConversationSystem,
      });
      const capBudget =
        retention.totalCapTokens -
        prefixTokens -
        (retention.summaryMaxTokens ?? DEFAULT_RETENTION_SUMMARY_TOKENS) -
        RETENTION_CAP_MARGIN_TOKENS;
      budgetTokens = Math.min(budgetTokens, Math.max(0, capBudget));
    }

    const maxGroups = split.groups.length - 2;
    let preservedGroupCount = 0;
    let accumulated = 0;
    for (let index = split.groups.length - 1; index >= 0 && preservedGroupCount < maxGroups; index -= 1) {
      if (accumulated >= budgetTokens) break;
      accumulated += estimateRuntimeEntryTokens(split.groups[index]!, {
        useMidConversationSystem: retention.useMidConversationSystem,
      });
      preservedGroupCount += 1;
    }

    // 预算为 0 时保留 0 组；slice(-0) 会误取全部轮组，必须显式判空。
    const preservedEntries =
      preservedGroupCount > 0
        ? split.groups.slice(-preservedGroupCount).flat().map(cloneRuntimeEntry)
        : [];
    const summaryGroups =
      preservedGroupCount > 0 ? split.groups.slice(0, split.groups.length - preservedGroupCount) : split.groups;
    return {
      entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
      groupsPreserved: preservedGroupCount,
      preservedEntries,
      totalGroups: split.groups.length,
    };
  }

  // user-messages：从尾部收集真实用户消息，直到 token 预算。
  if (strategy.kind !== "user-messages") {
    return {
      entriesForSummary: [...split.prefixEntries, ...split.groups.flat()].map(cloneRuntimeEntry),
      groupsPreserved: 0,
      preservedEntries: [],
      totalGroups: split.groups.length,
    };
  }
  const bodyEntries = split.groups.flat();
  const preservedEntries: RuntimeMessageEntry[] = [];
  let accumulated = 0;
  let oldestPreservedIndex = bodyEntries.length;
  for (let index = bodyEntries.length - 1; index >= 0; index -= 1) {
    if (accumulated >= strategy.maxTokens) break;
    const entry = bodyEntries[index]!;
    if (!isRealUserMessageEntry(entry)) continue;
    const entryTokens = estimateRuntimeEntryTokens([entry], {
      useMidConversationSystem: retention.useMidConversationSystem,
    });
    const remainingBudget = strategy.maxTokens - accumulated;
    if (entryTokens > remainingBudget) {
      // 单条超预算（如粘贴大文档）：对齐 Codex 的截断保留语义——保头不保整，
      // 否则一条大消息就能吃掉整个预算、压缩率转负。
      preservedEntries.unshift(truncateRealUserEntryForRetention(entry, remainingBudget));
      accumulated = strategy.maxTokens;
      oldestPreservedIndex = index;
      break;
    }
    accumulated += entryTokens;
    preservedEntries.unshift(entry);
    oldestPreservedIndex = index;
  }
  if (preservedEntries.length === 0) {
    return {
      entriesForSummary: [...split.prefixEntries, ...bodyEntries].map(cloneRuntimeEntry),
      groupsPreserved: 0,
      preservedEntries: [],
      totalGroups: split.groups.length,
    };
  }

  const summaryEntries = bodyEntries
    .filter((_, index) => index < oldestPreservedIndex || !preservedEntries.includes(bodyEntries[index]!))
    .map(cloneRuntimeEntry);
  // 持久化 tail 记录按「保留集合跨越的轮数」近似，保持 selectPersistedCompactTail 语义。
  let groupsSpanned = 0;
  let seenPreserved = false;
  for (const group of split.groups) {
    if (group.some((entry) => preservedEntries.includes(entry))) {
      groupsSpanned += 1;
      seenPreserved = true;
    } else if (seenPreserved) {
      // 保留区间内的非用户消息轮也属于跨越范围。
      groupsSpanned += 1;
    }
  }
  return {
    entriesForSummary: [...split.prefixEntries, ...summaryEntries].map(cloneRuntimeEntry),
    groupsPreserved: groupsSpanned,
    preservedEntries: preservedEntries.map(cloneRuntimeEntry),
    totalGroups: split.groups.length,
  };
}

/** codex-style 保留预算内的单条截断：保头部 + 截断标记，其余部分进入摘要输入。 */
function truncateRealUserEntryForRetention(
  entry: RuntimeMessageEntry,
  budgetTokens: number,
): RuntimeMessageEntry {
  if (budgetTokens <= 0 || !("message" in entry)) return cloneRuntimeEntry(entry);
  const text = modelMessageContentToText(entry.message.content);
  const keepChars = Math.max(0, budgetTokens * 4 - 120);
  if (text.length <= keepChars) return cloneRuntimeEntry(entry);
  const truncated = `${text.slice(0, keepChars)}\n\n[... message truncated to fit the compaction retention budget; see the summary for the rest ...]`;
  const cloned = cloneRuntimeEntry(entry);
  if (!("message" in cloned)) return cloned;
  return { ...cloned, message: { ...cloned.message, content: truncated } };
}

function isRealUserMessageEntry(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  if (entry.message.role !== "user") return false;
  if (isToolResultUserMessage(entry.message)) return false;
  const source = entry.metadata?.source;
  return !source || source === "real_user";
}

/**
 * deepseek-style 预设：进入摘要输入前对超长工具结果做免模型裁剪（头+尾保留）。
 * 只影响摘要请求的输入副本，保留区原文与持久化历史不变。
 */
export function pruneCompactSummaryToolResults(
  entries: readonly RuntimeMessageEntry[],
  config: { maxChars: number; headChars: number; tailChars: number },
): RuntimeMessageEntry[] {
  return entries.map((entry) => {
    if (isRuntimeAttachmentEntry(entry)) return entry;
    const message = entry.message;
    if (message.role !== "user" || !isToolResultUserMessage(message)) return entry;
    const text = modelMessageContentToText(message.content);
    if (text.length <= config.maxChars) return entry;
    const omitted = text.length - config.headChars - config.tailChars;
    const prunedText = [
      text.slice(0, config.headChars),
      "",
      `[Tool output pruned for compaction; ${omitted} middle characters omitted]`,
      "",
      text.slice(-config.tailChars),
    ].join("\n");
    return {
      ...entry,
      message: { ...message, content: prunedText },
    } satisfies RuntimeMessageEntry;
  });
}

const DEFAULT_RETENTION_WINDOW_TOKENS = 200_000;
const DEFAULT_RETENTION_SUMMARY_TOKENS = 20_000;

function countRecentGroupsToPreserveAfterPromptTooLong(
  groupsForSummary: readonly RuntimeMessageEntry[][],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  if (tokenGap === undefined) {
    return 1;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(groupsForSummary, {
    useMidConversationSystem: options.useMidConversationSystem,
  });
  return countRecentGroupsToCoverTokenGap(groupTokenEstimates, groupsForSummary.length, tokenGap);
}

function countRecentGroupsToCoverTokenGap(
  groupTokenEstimates: readonly number[],
  groupCount: number,
  tokenGap: number,
): number {
  if (tokenGap <= 0 || groupCount <= 0) {
    return 0;
  }

  let tokensCovered = 0;
  let groupsCovered = 0;
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    tokensCovered += groupTokenEstimates[index] ?? 0;
    groupsCovered += 1;
    if (tokensCovered >= tokenGap) break;
  }

  if (groupsCovered >= groupCount - 1) {
    return Math.max(1, Math.floor(groupCount / 2));
  }
  return Math.max(1, groupsCovered);
}

function estimateCompactGroupTokens(
  groups: readonly RuntimeMessageEntry[][],
  options: { useMidConversationSystem?: boolean } = {},
): number[] {
  return groups.map((group) =>
    estimateRuntimeEntryTokens(group, {
      useMidConversationSystem: options.useMidConversationSystem,
    }),
  );
}

function truncateRuntimeEntriesForCompactRetry(
  entries: readonly RuntimeMessageEntry[],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): RuntimeMessageEntry[] | null {
  const prefix: RuntimeMessageEntry[] = [];
  let index = 0;
  while (index < entries.length && isRuntimeContextPrefixEntry(entries[index]!)) {
    prefix.push(cloneRuntimeEntry(entries[index]!));
    index += 1;
  }

  let candidates = entries.slice(index);
  if (candidates[0] && isCompactPromptTooLongRetryMarker(candidates[0])) {
    candidates = candidates.slice(1);
  }

  const groups = groupRuntimeEntriesByCompactRound(candidates);
  if (groups.length < 2) return null;

  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  let dropCount = 0;
  if (tokenGap !== undefined) {
    let droppedTokens = 0;
    for (const group of groups) {
      droppedTokens += estimateRuntimeEntryTokens(group, {
        useMidConversationSystem: options.useMidConversationSystem,
      });
      dropCount += 1;
      if (droppedTokens >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  }

  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const sliced = groups.slice(dropCount).flat().map(cloneRuntimeEntry);
  if (sliced.length === 0) return null;

  const needsMarker = sliced[0] && runtimeEntryRole(sliced[0]) === "assistant";
  return [
    ...prefix,
    ...(needsMarker
      ? [
          {
            message: {
              role: "user" as const,
              content: COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
            },
          },
        ]
      : []),
    ...sliced,
  ];
}

function isRuntimeContextPrefixEntry(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) {
    return entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing";
  }
  if (entry.message.role === "system") return true;
  if (entry.message.role !== "user") return false;
  if (entry.metadata) {
    return entry.metadata.source === "context_prefix" || entry.metadata.source === "skills_listing";
  }
  return modelMessageContentToText(entry.message.content)
    .trimStart()
    .startsWith("<system-reminder>");
}

function isCompactPromptTooLongRetryMarker(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry)) return false;
  return (
    entry.message.role === "user" &&
    modelMessageContentToText(entry.message.content) === COMPACT_PROMPT_TOO_LONG_RETRY_MARKER
  );
}

function groupRuntimeEntriesByCompactRound(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[][] {
  return groupByAssistantStartedRounds(entries, runtimeEntryRole);
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function getPromptTooLongTokenGap(cause: unknown): number | undefined {
  let current: unknown = cause;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current === "string") {
      const gap = parsePromptTooLongTokenGap(current);
      if (gap !== undefined) return gap;
      return undefined;
    }
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    if (seen.has(current)) return undefined;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ["message", "errorDetails", "details", "body"]) {
      const value = record[key];
      if (typeof value === "string") {
        const gap = parsePromptTooLongTokenGap(value);
        if (gap !== undefined) return gap;
      }
    }
    current = record.cause ?? record.lastError ?? record.error;
  }

  return undefined;
}

function parsePromptTooLongTokenGap(message: string): number | undefined {
  const match = message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (!match) return undefined;

  const actual = Number(match[1]?.replace(/,/g, ""));
  const limit = Number(match[2]?.replace(/,/g, ""));
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) {
    return undefined;
  }
  return Math.ceil(actual - limit);
}

function cloneRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  return cloneRuntimeMessageEntry(entry);
}

function runtimeEntryRole(entry: RuntimeMessageEntry): "system" | "user" | "assistant" | "tool" {
  if (isRuntimeAttachmentEntry(entry)) return "user";
  return entry.message.role;
}
