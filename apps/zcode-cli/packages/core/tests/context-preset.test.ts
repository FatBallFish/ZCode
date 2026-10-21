import { describe, expect, it } from "vitest";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  legacySyntheticRuntimeMetadata,
  systemReminderAttachmentEntry,
} from "../src/agent/message-history.js";
import {
  AGENT_CONTEXT_PRESETS,
  resolveContextPreset,
} from "../src/compact/policy.js";
import {
  buildCompactPrompt,
  buildCompactSummaryMessage,
} from "../src/compact/prompt.js";
import {
  getAutoCompactThreshold,
  shouldAutoCompact,
} from "../src/compact/policy.js";
import {
  pruneCompactSummaryToolResults,
  selectCompactEntries,
} from "../src/runtime/helpers/compact-selection.js";
import { buildPostCompactRuntimeEntries } from "../src/runtime/helpers/compact.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

function userEntry(content: string): RuntimeMessageEntry {
  return { message: { role: "user", content }, metadata: { source: "real_user" } };
}

function assistantEntry(content: string): RuntimeMessageEntry {
  return { message: { role: "assistant", content } };
}

function toolResultEntry(content: string, toolCallId: string): RuntimeMessageEntry {
  return {
    message: {
      role: "user",
      content: [{ type: "text", text: content }],
      toolCallId,
      toolName: "Read",
    },
  };
}

function contextAttachment(content: string): RuntimeMessageEntry {
  return systemReminderAttachmentEntry("context_prefix", content);
}

/** 前缀 + N 个轮组；每轮 = 用户输入 + assistant + 工具结果（chars/4 估算 token）。 */
function buildConversation(rounds: number, charsPerRound: number): RuntimeMessageEntry[] {
  const filler = "x".repeat(charsPerRound);
  const entries: RuntimeMessageEntry[] = [
    { message: { role: "system", content: "stable system" } },
    contextAttachment("AGENTS.md body"),
  ];
  for (let round = 1; round <= rounds; round += 1) {
    entries.push(userEntry(`${filler} user ${round}`));
    entries.push(assistantEntry(`${filler} assistant ${round}`));
    entries.push(toolResultEntry(`${filler} result ${round}`, `tool-${round}`));
  }
  return entries;
}

describe("context presets", () => {
  it("exposes exactly four presets and resolves default fallback", () => {
    expect([...AGENT_CONTEXT_PRESETS]).toEqual([
      "default",
      "fused",
      "deepseek-style",
      "codex-style",
    ]);
    expect(resolveContextPreset(undefined).preset).toBe("default");
    expect(resolveContextPreset("fused").cacheLayout).toBe("anchored");
    expect(resolveContextPreset("default").cacheLayout).toBe("legacy");
  });

  it("applies preset ratio thresholds", () => {
    const base = { contextWindow: 200_000, maxOutputTokens: 32_000 };
    // default：effective = 200k − 21k = 179k，threshold = 179k − 13k = 166k
    expect(getAutoCompactThreshold({ ...base })).toBe(166_000);
    // fused：min(0.85×200k, 179k) = 170k
    expect(getAutoCompactThreshold({ ...base, contextPreset: "fused" })).toBe(170_000);
    // deepseek：min(0.8×200k, 179k − 65536) = 113464
    expect(getAutoCompactThreshold({ ...base, contextPreset: "deepseek-style" })).toBe(113_464);
    // codex：min(0.9×200k, 179k) = 179k
    expect(getAutoCompactThreshold({ ...base, contextPreset: "codex-style" })).toBe(179_000);
  });

  it("reports derived threshold percent under presets", () => {
    const decision = shouldAutoCompact({
      config: { contextWindow: 200_000, contextPreset: "fused" },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "hi" },
      ],
      tokenOverride: {
        source: "provider_usage",
        tokenCount: 171_000,
      },
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.thresholdPercent).toBe(85);
  });

  it("builds preset-specific compact prompts", () => {
    const detailed = buildCompactPrompt(undefined, "detailed");
    expect(detailed).toContain("Primary Request and Intent");
    expect(detailed).not.toContain("Files Read and Examined");

    const fused = buildCompactPrompt(undefined, "detailed-plus");
    expect(fused).toContain("Files Read and Examined");
    expect(fused).toContain("Current Todo and Plan");
    expect(fused).toContain("prior compaction summary");

    const deepseek = buildCompactPrompt(undefined, "checkpoint-8");
    expect(deepseek).toContain("## Critical Context");
    expect(deepseek).toContain("<compacted-summary>");

    const codex = buildCompactPrompt(undefined, "handoff");
    expect(codex).toContain("CONTEXT CHECKPOINT COMPACTION");
  });

  it("builds preset-specific summary preambles", () => {
    const cont = buildCompactSummaryMessage("S", { suppressFollowup: true });
    expect(cont).toContain("This session is being continued");

    const handoff = buildCompactSummaryMessage("S", {
      suppressFollowup: true,
      preamble: "handoff",
    });
    expect(handoff).toContain("Another language model started");
    expect(handoff).not.toContain("This session is being continued");
  });

  it("preserves tail rounds under token-budget retention", () => {
    const entries = buildConversation(6, 800); // 每轮 ≈ 600 tokens
    const legacy = selectCompactEntries({ entries, trigger: "auto" as never });
    expect(legacy.groupsPreserved).toBe(1);

    // 预算 0.16 × 1000 = 160 tokens < 一轮（≈600）→ 保留 1 组。
    const budgeted = selectCompactEntries({
      entries,
      trigger: "auto" as never,
      retention: {
        strategy: { kind: "token-budget", ratio: 0.16 },
        effectiveContextWindow: 1_000,
      },
    });
    expect(budgeted.groupsPreserved).toBe(1);
    expect(budgeted.preservedEntries.at(-1)?.message).toBeDefined();
    // 摘要输入包含更早轮组的工具结果，但不包含保留轮组。
    const summaryText = JSON.stringify(budgeted.entriesForSummary);
    expect(summaryText).toContain("result 5");
    expect(summaryText).not.toContain("result 6");

    // 预算放大到覆盖 3 轮 → 保留 3 组。
    const budgetedWide = selectCompactEntries({
      entries,
      trigger: "auto" as never,
      retention: {
        strategy: { kind: "token-budget", ratio: 0.9 },
        effectiveContextWindow: 2_000,
      },
    });
    expect(budgetedWide.groupsPreserved).toBe(3);
  });

  it("shrinks retention budget to avoid retrigger next turn", () => {
    const entries = buildConversation(6, 800);
    // 阈值仅 700：扣除 prefix 与摘要预留后预算为负 → 保留 0 组，全部进入摘要，
    // 保证压缩后总量不再越过阈值（不再连环压缩）。
    const capped = selectCompactEntries({
      entries,
      trigger: "auto" as never,
      retention: {
        strategy: { kind: "token-budget", ratio: 0.9 },
        effectiveContextWindow: 2_000,
        totalCapTokens: 700,
        summaryMaxTokens: 20_000,
      },
    });
    expect(capped.groupsPreserved).toBe(0);
    expect(capped.preservedEntries).toEqual([]);
    // 未设上限时同一输入保留 3 组，证明 cap 是收缩来源。
    expect(
      selectCompactEntries({
        entries,
        trigger: "auto" as never,
        retention: {
          strategy: { kind: "token-budget", ratio: 0.9 },
          effectiveContextWindow: 2_000,
        },
      }).groupsPreserved,
    ).toBe(3);
  });

  it("preserves only real user messages under codex-style retention", () => {
    const entries = buildConversation(4, 2000); // 每条用户消息 ≈ 510 tokens
    const selection = selectCompactEntries({
      entries,
      trigger: "auto" as never,
      retention: { strategy: { kind: "user-messages", maxTokens: 700 } },
    });
    // 从尾部累计：u4(≈510) < 700，再收 u3 → ≈1020 ≥ 700 停止。
    expect(selection.preservedEntries.length).toBe(2);
    for (const preserved of selection.preservedEntries) {
      expect(preserved).toHaveProperty("message.role", "user");
      expect(preserved).not.toHaveProperty("message.toolCallId");
    }
    const summaryText = JSON.stringify(selection.entriesForSummary);
    expect(summaryText).toContain("assistant 1");
    expect(summaryText).not.toContain("user 4");
  });

  it("truncates a single oversized user message instead of exceeding the codex-style budget", () => {
    const entries = buildConversation(3, 100);
    // 末尾追加一条 40k-token 级的粘贴文档消息，预算只有 5k：必须截断保留而不是整条吃掉预算。
    const doc = "d".repeat(160_000);
    const withDoc = [...entries, userEntry(`PASTED DOC:\n${doc}`)];
    const selection = selectCompactEntries({
      entries: withDoc,
      trigger: "auto" as never,
      retention: { strategy: { kind: "user-messages", maxTokens: 5_000 } },
    });
    const preservedText = selection.preservedEntries
      .map((entry) => ("message" in entry ? String(entry.message.content) : ""))
      .join("\n");
    expect(preservedText).toContain("message truncated to fit the compaction retention budget");
    expect(preservedText.length).toBeLessThan(160_000);
  });

  it("prunes oversized tool results for the summary input only", () => {
    const entries = buildConversation(2, 100);
    const big = entries.map((entry) =>
      "message" in entry && entry.message.role === "user" && entry.message.toolCallId
        ? { ...entry, message: { ...entry.message, content: [{ type: "text" as const, text: "y".repeat(20_000) }] } }
        : entry,
    );
    const prunedTool = pruneCompactSummaryToolResults(big, {
      maxChars: 8_192,
      headChars: 4_096,
      tailChars: 1_024,
    }).find((entry) => "message" in entry && entry.message.role === "user" && entry.message.toolCallId);
    const text = JSON.stringify(prunedTool?.message.content);
    expect(text).toContain("Tool output pruned for compaction");
    expect(text?.length ?? 0).toBeLessThan(20_000);
    // 原始 entries 不被改动。
    const originalTool = big.find(
      (entry) => "message" in entry && entry.message.role === "user" && entry.message.toolCallId,
    );
    expect(JSON.stringify(originalTool && "message" in originalTool ? originalTool.message.content : null).length).toBeGreaterThan(19_000);
  });

  it("places the summary at the tail for codex-style compaction", () => {
    const prefix = { message: { role: "system" as const, content: "sys" } };
    const preserved = userEntry("kept user turn");
    const reminders = [systemReminderAttachmentEntry("todo_reminder", "todos")];
    const summaryEntry: RuntimeMessageEntry = {
      message: { role: "user", content: "summary" },
      metadata: legacySyntheticRuntimeMetadata(),
    };

    const tailOrder = buildPostCompactRuntimeEntries([prefix], summaryEntry, {
      preservedEntries: [preserved],
      postCompactReminderEntries: reminders,
      summaryPosition: "tail",
    });
    expect(
      tailOrder.map((entry) => ("message" in entry ? entry.message.content : entry.content)),
    ).toEqual([
      "sys",
      "kept user turn",
      "summary",
      "todos",
    ]);

    const defaultOrder = buildPostCompactRuntimeEntries([prefix], summaryEntry, {
      preservedEntries: [preserved],
      postCompactReminderEntries: reminders,
    });
    expect(
      defaultOrder.map((entry) => ("message" in entry ? entry.message.content : entry.content)),
    ).toEqual([
      "sys",
      "summary",
      "kept user turn",
      "todos",
    ]);
  });

  it("anchors cache breakpoints on system, context attachment, summary, and latest", () => {
    const summaryEntry: RuntimeMessageEntry = {
      message: { role: "user", content: "compact summary" },
      metadata: {
        ...legacySyntheticRuntimeMetadata(),
        compactBoundary: { boundaryId: "b1" } as never,
      },
    };
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "cli prefix" } },
      { message: { role: "system", content: "stable body", cacheControl: { type: "ephemeral" } } },
      { message: { role: "system", content: "dynamic block", cacheControl: { type: "ephemeral" } } },
      contextAttachment("AGENTS.md body"),
      systemReminderAttachmentEntry("skills_listing", "skills list"),
      summaryEntry,
      userEntry("latest user"),
    ];

    const anchored = buildProviderRequestMessages({
      entries,
      applyCacheControl: true,
      useMidConversationSystem: false,
      cacheLayout: "anchored",
    });
    const anchoredBreakpoints = anchored.messages
      .map((message, index) => (message.cacheControl ? index : -1))
      .filter((index) => index >= 0);
    expect(anchoredBreakpoints).toEqual([2, 4, 5, 6]);
    // anchored 布局下第一条 system 断点被合并到最后一条 system。
    expect(anchored.messages[1]?.cacheControl).toBeUndefined();

    const legacy = buildProviderRequestMessages({
      entries,
      applyCacheControl: true,
      useMidConversationSystem: false,
    });
    const legacyBreakpoints = legacy.messages
      .map((message, index) => (message.cacheControl ? index : -1))
      .filter((index) => index >= 0);
    expect(legacyBreakpoints).toEqual([1, 2, 6]);
  });
});
