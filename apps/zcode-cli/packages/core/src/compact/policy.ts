import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens, hasEnoughMessagesToCompact } from "./manual.js";
import type { LocalMicrocompactPolicyConfig } from "./microcompact.js";


// -----------------------------------------------
// Agent 上下文预设（唯一所有者；详见 docs/specs/agent-context-preset.md）
// -----------------------------------------------
/**
 * Agent 上下文预设：把「系统提示词缓存布局 + 会话压缩算法」的差异收敛为一个枚举，
 * 由 runtime 配置选择；本文件是预设语义的唯一所有者，其他模块只读取这里解析出的参数。
 *
 * - `default`：现有行为（兼容基线）。
 * - `fused`：三方融合优化（锚定断点布局、token 预算尾部保留、摘要增强、transcript 回读）。
 * - `deepseek-style`：对齐 DeepSeek Harness compaction-basic 的默认值与 8 段 checkpoint 模板。
 * - `codex-style`：对齐 Codex 的 handoff 摘要、用户消息倒序保留与摘要尾置。
 */

export const AGENT_CONTEXT_PRESETS = ["default", "fused", "deepseek-style", "codex-style"] as const;

export type AgentContextPreset = (typeof AGENT_CONTEXT_PRESETS)[number];

export const DEFAULT_AGENT_CONTEXT_PRESET: AgentContextPreset = "default";

export type CompactRetentionStrategy =
  | { kind: "legacy-groups" }
  /** 从尾部按 token 预算保留完整轮组原文；ratio 相对有效上下文窗口。 */
  | { kind: "token-budget"; ratio: number }
  /** 只保留真实用户消息（非工具结果），从最新往前累计到 maxTokens。 */
  | { kind: "user-messages"; maxTokens: number };

export type CompactSummaryTemplate = "detailed" | "detailed-plus" | "checkpoint-8" | "handoff";

export type CompactSummaryPreamble = "continue" | "handoff";

export type CompactSummaryPosition = "after-prefix" | "tail";

export type ProviderCacheLayout = "legacy" | "anchored";

export interface CompactReadStateLimits {
  readonly maxFiles: number;
  readonly maxFileApproxTokens: number;
  readonly maxTotalApproxTokens: number;
}

export interface CompactToolResultPrunerConfig {
  readonly maxChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}

export interface ContextPresetConfig {
  readonly preset: AgentContextPreset;
  /** 自动压缩阈值相对原始上下文窗口的比例；缺省沿用现有绝对阈值算法。 */
  readonly thresholdRatio?: number;
  /** 比例阈值之外再从有效窗口扣除的余量（DeepSeek headroom）。 */
  readonly thresholdHeadroomTokens?: number;
  readonly retention: CompactRetentionStrategy;
  readonly summaryTemplate: CompactSummaryTemplate;
  readonly summaryPreamble: CompactSummaryPreamble;
  readonly summaryPosition: CompactSummaryPosition;
  readonly readStateLimits: CompactReadStateLimits;
  /** 摘要消息附带会话 transcript 路径，供模型回读压缩前原文。 */
  readonly transcriptReference: boolean;
  /** 进入摘要输入前对超长工具结果做免模型裁剪；不影响保留原文。 */
  readonly toolResultPruner?: CompactToolResultPrunerConfig;
  /** 压缩后立即注入一次当前 todo 列表。 */
  readonly injectTodoAfterCompact: boolean;
  readonly cacheLayout: ProviderCacheLayout;
  /** 保留预算不得使压缩后总量越过阈值，避免下一轮连环压缩。 */
  readonly capRetentionToThreshold: boolean;
}

const LEGACY_READ_STATE_LIMITS: CompactReadStateLimits = {
  maxFiles: 5,
  maxFileApproxTokens: 5_000,
  maxTotalApproxTokens: 50_000,
};

const EXPANDED_READ_STATE_LIMITS: CompactReadStateLimits = {
  maxFiles: 10,
  maxFileApproxTokens: 8_000,
  maxTotalApproxTokens: 80_000,
};

const PRESET_CONFIGS: Readonly<Record<AgentContextPreset, ContextPresetConfig>> = {
  default: {
    preset: "default",
    retention: { kind: "legacy-groups" },
    summaryTemplate: "detailed",
    summaryPreamble: "continue",
    summaryPosition: "after-prefix",
    readStateLimits: LEGACY_READ_STATE_LIMITS,
    transcriptReference: false,
    injectTodoAfterCompact: false,
    cacheLayout: "legacy",
    capRetentionToThreshold: false,
  },
  fused: {
    preset: "fused",
    thresholdRatio: 0.85,
    retention: { kind: "token-budget", ratio: 0.16 },
    summaryTemplate: "detailed-plus",
    summaryPreamble: "continue",
    summaryPosition: "after-prefix",
    readStateLimits: EXPANDED_READ_STATE_LIMITS,
    transcriptReference: true,
    injectTodoAfterCompact: true,
    cacheLayout: "anchored",
    capRetentionToThreshold: true,
  },
  "deepseek-style": {
    preset: "deepseek-style",
    thresholdRatio: 0.8,
    thresholdHeadroomTokens: 65_536,
    retention: { kind: "token-budget", ratio: 0.16 },
    summaryTemplate: "checkpoint-8",
    summaryPreamble: "continue",
    summaryPosition: "after-prefix",
    readStateLimits: EXPANDED_READ_STATE_LIMITS,
    transcriptReference: false,
    toolResultPruner: { maxChars: 8_192, headChars: 4_096, tailChars: 1_024 },
    injectTodoAfterCompact: true,
    cacheLayout: "anchored",
    capRetentionToThreshold: true,
  },
  "codex-style": {
    preset: "codex-style",
    thresholdRatio: 0.9,
    retention: { kind: "user-messages", maxTokens: 20_000 },
    summaryTemplate: "handoff",
    summaryPreamble: "handoff",
    summaryPosition: "tail",
    readStateLimits: LEGACY_READ_STATE_LIMITS,
    transcriptReference: false,
    injectTodoAfterCompact: false,
    cacheLayout: "anchored",
    capRetentionToThreshold: true,
  },
};

export function isAgentContextPreset(value: unknown): value is AgentContextPreset {
  return (
    typeof value === "string" && (AGENT_CONTEXT_PRESETS as readonly string[]).includes(value)
  );
}

export function resolveContextPreset(preset: AgentContextPreset | undefined): ContextPresetConfig {
  return PRESET_CONFIGS[preset ?? DEFAULT_AGENT_CONTEXT_PRESET];
}

export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
// 正常请求默认输出已收敛到 32K，auto compact 必须预留同一目标；
// 否则请求预算和压缩窗口会继续按两套常量计算。
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  summaryReserveTokens?: number;
  bufferTokens?: number;
  thresholdPercentOverride?: number;
  maxConsecutiveFailures?: number;
  microcompact?: LocalMicrocompactPolicyConfig;
  /** 上下文预设决定阈值比例语义；缺省沿用 legacy 绝对阈值算法。 */
  contextPreset?: AgentContextPreset;
}

export type AutoCompactTokenSource = "estimate" | "provider_usage";

export interface AutoCompactTokenOverride {
  baseTokenCount?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokenCount?: number;
  incrementalTokenCount?: number;
  outputTokens?: number;
  source: Extract<AutoCompactTokenSource, "provider_usage">;
  tokenCount: number;
}

export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: AutoCompactTokenSource;
  estimatedTokenCount: number;
  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
  providerBaseTokenCount?: number;
  providerContextUsageTokenCount?: number;
  providerIncrementalTokenCount?: number;
  providerOutputTokens?: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1";
  outputReserveTokens: number;
  thresholdPercent: number;
  reason:
    | "disabled"
    | "not_enough_messages"
    | "circuit_breaker"
    | "below_threshold"
    | "above_threshold";
}

export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  // 旧 legacy 分支为完整模型输出预留窗口，既过早压缩又要求远端选择；现在统一保留至多 21K。
  return Math.min(
    maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  );
}

export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const preset = resolveContextPreset(config.contextPreset);
  if (preset.thresholdRatio !== undefined) {
    // 比例阈值语义：fused 85% / deepseek 80%+headroom / codex 90%，都以原始窗口为分母，
    // 同时不得超过「窗口 − 输出预留」的有效上限，避免阈值反过来吃掉输出预算。
    const ratioThreshold = preset.thresholdRatio * contextWindow;
    const effectiveCap =
      preset.thresholdHeadroomTokens !== undefined
        ? effectiveContextWindow - preset.thresholdHeadroomTokens
        : effectiveContextWindow;
    return Math.max(0, Math.floor(Math.min(ratioThreshold, effectiveCap)));
  }
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, effectiveContextWindow - buffer);
}

export function shouldAutoCompact(input: {
  messages: readonly CompactModelMessage[];
  config?: AutoCompactPolicyConfig;
  consecutiveFailures?: number;
  tokenOverride?: AutoCompactTokenOverride;
}): AutoCompactDecision {
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const outputReserveTokens = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  const threshold = getAutoCompactThreshold(config);
  // 预设模式下 threshold 来自比例语义，诊断用的百分比按真实阈值换算，不再硬编码 100。
  const thresholdPercent =
    config.contextPreset === undefined
      ? DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT
      : Math.round((threshold / Math.max(1, contextWindow)) * 100);
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = input.tokenOverride?.tokenCount ?? estimatedTokenCount;
  const tokenSource = input.tokenOverride?.source ?? "estimate";
  const common = {
    contextWindow,
    effectiveContextWindow,
    estimatedTokenCount,
    providerCacheReadTokens: input.tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: input.tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    outputReserveTokens,
    providerBaseTokenCount: input.tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: input.tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: input.tokenOverride?.incrementalTokenCount,
    providerOutputTokens: input.tokenOverride?.outputTokens,
    threshold,
    thresholdPercent,
    tokenCount,
    tokenSource,
  } satisfies Omit<AutoCompactDecision, "reason" | "shouldCompact">;

  if (config.enabled === false) {
    return { ...common, shouldCompact: false, reason: "disabled" };
  }

  if (!hasEnoughMessagesToCompact(input.messages)) {
    return {
      ...common,
      shouldCompact: false,
      reason: "not_enough_messages",
    };
  }

  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures) {
    return {
      ...common,
      shouldCompact: false,
      reason: "circuit_breaker",
    };
  }

  if (tokenCount < threshold) {
    return {
      ...common,
      shouldCompact: false,
      reason: "below_threshold",
    };
  }

  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
