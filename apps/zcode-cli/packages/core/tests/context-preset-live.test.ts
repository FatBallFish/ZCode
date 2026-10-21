/**
 * 上下文预设真实模型长上下文实测（含手动压缩）。
 *
 * 运行方式（默认 skip，避免进入常规 CI/单测）：
 *   ZCODE_LIVE_BENCH=glm,deepseek,gpt npx vitest run tests/context-preset-live.test.ts --testTimeout=3600000
 *
 * 读取 ~/.zcode/v2/provider_config.json 中已配置的 provider（不打印任何密钥），
 * 对每个 preset × model：
 *   1) 构造「3 条 system + context_prefix 附件 + 用户粘贴项目手册 + 多轮问答」的长上下文；
 *   2) 每轮用 core 真实的 buildProviderRequestMessages 按预设布局打 cache_control 断点并发起真实请求；
 *   3) 中途手动压缩：真实 selectCompactEntries + buildCompactPrompt + buildCompactSummaryMessage
 *      + buildPostCompactRuntimeEntries（完全复用产品代码路径）；
 *   4) 压缩后 3 轮回忆探针，检验摘要保留事实的能力；
 *   5) 逐请求记录 usage（cache read/write），输出 JSON 到 .bench-results/。
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelInputMessage, RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  legacySyntheticRuntimeMetadata,
  systemReminderAttachmentEntry,
} from "../src/agent/message-history.js";
import { AGENT_CONTEXT_PRESETS, resolveContextPreset } from "../src/compact/policy.js";
import {
  buildCompactPrompt,
  buildCompactSummaryMessage,
  formatCompactSummary,
} from "../src/compact/prompt.js";
import { MAX_OUTPUT_TOKENS_FOR_SUMMARY } from "../src/compact/policy.js";
import {
  selectCompactEntries,
  estimateRuntimeEntryTokens,
} from "../src/runtime/helpers/compact-selection.js";
import { buildPostCompactRuntimeEntries } from "../src/runtime/helpers/compact.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

const RESULTS_DIR = join(import.meta.dirname, "..", "..", "..", ".bench-results");
const DOC_SECTIONS = Number(process.env.ZCODE_BENCH_DOC_SECTIONS ?? 40);
const PRE_TURNS = Number(process.env.ZCODE_BENCH_PRE_TURNS ?? 8);
const POST_TURNS = 3;

interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Target {
  key: string;
  label: string;
  wire: "anthropic" | "openai-responses" | "openai-chat";
  baseUrl: string;
  apiKey: string;
  models: string[];
  contextWindow: number;
  authStyle: "x-api-key" | "bearer";
  /** responses wire 是否携带 prompt_cache_key（sub2api 依赖它做账号粘性路由）。 */
  promptCacheKey?: boolean;
  /** 完全对齐 Codex 客户端：额外发送 metadata.user_id（sub2api 粘性调度的最高优先来源）。 */
  codexClientIdentity?: boolean;
}

function loadProviderConfig(): Record<string, unknown> {
  const path = join(process.env.HOME ?? "", ".zcode", "v2", "provider_config.json");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function resolveTargets(): Target[] {
  const wanted = (process.env.ZCODE_LIVE_BENCH ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const config = loadProviderConfig() as {
    config?: { providerConfigRules?: { providerRules?: Array<Record<string, unknown>> } };
  };
  const rules = config.config?.providerConfigRules?.providerRules ?? [];
  const byProvider = new Map(rules.map((rule) => [String(rule.providerId), rule]));
  const apiKeyOf = (providerId: string): string => {
    const rule = byProvider.get(providerId) as
      | { config?: { access?: { apiKey?: string } } }
      | undefined;
    return String(rule?.config?.access?.apiKey ?? "");
  };

  const targets: Target[] = [];
  if (wanted.includes("glm")) {
    targets.push({
      key: "glm",
      label: "GLM-5.3 (bigmodel anthropic)",
      wire: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: apiKeyOf("bigmodel-api"),
      models: ["GLM-5.3", "GLM-5-Turbo"],
      contextWindow: 200_000,
      authStyle: "x-api-key",
    });
  }
  if (wanted.includes("deepseek")) {
    targets.push({
      key: "deepseek",
      label: "deepseek-v4.1-flash-1017 (MikikoCC anthropic)",
      wire: "anthropic",
      baseUrl: "https://api.mikiko.cc",
      apiKey: apiKeyOf("new-provider"),
      models: ["deepseek-v4.1-flash-1017", "deepseek-v4.1-flash"],
      contextWindow: 128_000,
      authStyle: "x-api-key",
      // 401 时尝试 bearer 的逻辑见 sendAnthropic。
    });
  }
  const gptBase = () => ({
    wire: "openai-responses" as const,
    baseUrl: "http://10.30.202.6:8080",
    apiKey: apiKeyOf("openai"),
    models: ["gpt-6.1-sol"],
    contextWindow: 500_000,
    authStyle: "bearer" as const,
  });
  if (wanted.includes("gpt")) {
    targets.push({ ...gptBase(), key: "gpt", label: "gpt-6.1-sol (EagleCloud sub2api, no prompt_cache_key)" });
  }
  if (wanted.includes("gpt-sticky")) {
    targets.push({
      ...gptBase(),
      key: "gpt-sticky",
      label: "gpt-6.1-sol (EagleCloud sub2api, prompt_cache_key=session)",
      promptCacheKey: true,
    });
  }
  if (wanted.includes("gpt-codexmode")) {
    targets.push({
      ...gptBase(),
      key: "gpt-codexmode",
      label: "gpt-6.1-sol (EagleCloud sub2api, Codex-style identity)",
      promptCacheKey: true,
      codexClientIdentity: true,
    });
  }
  return targets.filter((target) => target.apiKey.length > 0);
}

// ---------- 合成长上下文 ----------

interface Section {
  index: number;
  module: string;
  port: number;
  blob: string;
}

function buildHandbook(): { doc: string; sections: Section[] } {
  const sections: Section[] = [];
  for (let i = 1; i <= DOC_SECTIONS; i += 1) {
    const module = `Module-${String(i).padStart(2, "0")}`;
    const port = 51000 + i * 7;
    const blob = Array.from(
      { length: 24 },
      (_, line) =>
        `${module} note ${line}: the ${module.toLowerCase()}-pipeline normalizes record ${line} ` +
        `with tag ${module}-t${line} before dispatch; retries use jittered backoff of ${line % 7}s.`,
    ).join("\n");
    sections.push({ index: i, module, port, blob });
  }
  const doc = [
    "# Aurora Platform Handbook (internal)",
    "Each section documents one module. Facts (ports, owners) are authoritative.",
    ...sections.map(
      (section) =>
        `## Section ${section.index}: ${section.module}\n- Port: ${section.port}\n- Owner: team-${section.index}\n- Runtime notes:\n${section.blob}`,
    ),
  ].join("\n\n");
  return { doc, sections };
}

function userEntry(content: string): RuntimeMessageEntry {
  return { message: { role: "user", content }, metadata: { source: "real_user" } };
}

function assistantEntry(content: string): RuntimeMessageEntry {
  return { message: { role: "assistant", content } };
}

function buildInitialHistory(doc: string, nonce: string): RuntimeMessageEntry[] {
  return [
    { message: { role: "system", content: `You are Mikiko, an interactive coding agent that helps users with software engineering tasks. Use the tools available to you to assist the user.\n(bench run ${nonce})` } },
    { message: { role: "system", content: "# Harness\n- You are an agent. Follow the user's instructions carefully.\n- Answer concisely.\n- The project handbook pasted by the user is authoritative; never guess facts that appear in it.".repeat(6) } },
    { message: { role: "system", content: `# Environment\ncwd: /workspace/aurora\nplatform: darwin\nOS: macOS 15\ngitStatus: main @ clean (snapshot at conversation start)\n- You are powered by the model named bench/model.` } },
    systemReminderAttachmentEntry("context_prefix", "AGENTS.md: Keep answers short. Prefer exact numbers from the handbook over paraphrasing."),
    userEntry(
      `I'm pasting the full Aurora Platform Handbook below. Remember it; I will ask questions about specific sections later without re-pasting.\n\n${doc}`,
    ),
  ];
}

// ---------- wire 发送 ----------

function systemBlocks(messages: ModelInputMessage[]) {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => ({
      type: "text" as const,
      text: typeof message.content === "string" ? message.content : String(message.content),
      ...(message.cacheControl ? { cache_control: { type: "ephemeral" } } : {}),
    }));
}

type ChatBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

/** Anthropic wire 要求角色交替；相邻同角色消息在序列化边界合并（与 Mikiko adapter 职责一致）。 */
function chatMessages(messages: ModelInputMessage[]): Array<{ role: string; content: ChatBlock[] }> {
  const merged: Array<{ role: string; content: ChatBlock[] }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const block: ChatBlock = {
      type: "text",
      text: typeof message.content === "string" ? message.content : String(message.content),
      ...(message.cacheControl ? { cache_control: { type: "ephemeral" } } : {}),
    };
    const last = merged.at(-1);
    if (last && last.role === message.role) {
      last.content.push(block);
    } else {
      merged.push({ role: message.role, content: [block] });
    }
  }
  return merged;
}

function stripCacheControl(messages: ModelInputMessage[]): ModelInputMessage[] {
  return messages.map((message) =>
    message.cacheControl
      ? ({ ...message, cacheControl: undefined } as ModelInputMessage)
      : message,
  );
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 15_000 * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (attempt === 2) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  throw new Error("unreachable");
}

function anthropicHeaders(target: Target, bearer = false): Record<string, string> {
  return bearer
    ? { authorization: `Bearer ${target.apiKey}`, "anthropic-version": "2023-06-01" }
    : { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" };
}

async function sendAnthropic(
  target: Target,
  model: string,
  messages: ModelInputMessage[],
  maxTokens: number,
): Promise<{ text: string; usage: WireUsage }> {
  const body = {
    model,
    max_tokens: maxTokens,
    system: systemBlocks(messages),
    messages: chatMessages(messages),
  };
  try {
    const json = await postJson(
      `${target.baseUrl}/v1/messages`,
      anthropicHeaders(target),
      body,
    );
    return parseAnthropic(json);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (messageText.includes("HTTP 401") && target.authStyle === "x-api-key") {
      const json = await postJson(
        `${target.baseUrl}/v1/messages`,
        anthropicHeaders(target, true),
        body,
      );
      return parseAnthropic(json);
    }
    throw error;
  }
}

function parseAnthropic(json: Record<string, unknown>): { text: string; usage: WireUsage } {
  const usage = (json.usage ?? {}) as Record<string, number>;
  const content = (json.content ?? []) as Array<{ type: string; text?: string }>;
  return {
    text: content.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
    usage: {
      input: Number(usage.input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
      cacheRead: Number(usage.cache_read_input_tokens ?? 0),
      cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
    },
  };
}

async function sendOpenAi(
  target: Target,
  model: string,
  messages: ModelInputMessage[],
  maxTokens: number,
  wire: "openai-responses" | "openai-chat",
): Promise<{ text: string; usage: WireUsage }> {
  const headers = { authorization: `Bearer ${target.apiKey}` };
  if (wire === "openai-responses") {
    const json = await postJson(`${target.baseUrl}/v1/responses`, headers, {
      model,
      max_output_tokens: maxTokens,
      store: false,
      ...(target.promptCacheKey && activePromptCacheKey
        ? { prompt_cache_key: activePromptCacheKey }
        : {}),
      ...(target.codexClientIdentity && activePromptCacheKey
        ? { metadata: { user_id: `session_${activePromptCacheKey}` } }
        : {}),
      input: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : message.role,
        content: typeof message.content === "string" ? message.content : String(message.content),
      })),
    });
    const usage = (json.usage ?? {}) as Record<string, number>;
    const details = (usage.input_tokens_details ?? {}) as Record<string, number>;
    const outputText = Array.isArray(json.output)
      ? (json.output as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>)
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .filter((block) => block.type === "output_text")
          .map((block) => block.text ?? "")
          .join("")
      : String(json.output ?? "");
    return {
      text: outputText,
      usage: {
        input: Number(usage.input_tokens ?? 0),
        output: Number(usage.output_tokens ?? 0),
        cacheRead: Number(details.cached_tokens ?? 0),
        cacheWrite: 0,
      },
    };
  }
  const json = await postJson(`${target.baseUrl}/v1/chat/completions`, headers, {
    model,
    max_tokens: maxTokens,
    messages: messages.map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : String(message.content),
    })),
  });
  const usage = (json.usage ?? {}) as Record<string, number>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, number>;
  const choices = (json.choices ?? []) as Array<{ message?: { content?: string } }>;
  return {
    text: choices[0]?.message?.content ?? "",
    usage: {
      input: Number(usage.prompt_tokens ?? 0),
      output: Number(usage.completion_tokens ?? 0),
      cacheRead: Number(details.cached_tokens ?? 0),
      cacheWrite: 0,
    },
  };
}

let cacheControlUnsupported: string | null = null;
let activePromptCacheKey: string | null = null;
let lastWire: string = "";

async function send(
  target: Target,
  model: string,
  messages: ModelInputMessage[],
  maxTokens: number,
): Promise<{ text: string; usage: WireUsage }> {
  const deliver = async (payload: ModelInputMessage[]) => {
    if (target.wire === "anthropic") {
      lastWire = "anthropic";
      return sendAnthropic(target, model, payload, maxTokens);
    }
    try {
      lastWire = "responses";
      return await sendOpenAi(target, model, payload, maxTokens, "openai-responses");
    } catch (error) {
      // Responses 不通（404/405）时退回 chat completions。
      const messageText = error instanceof Error ? error.message : String(error);
      if (messageText.includes("HTTP 40")) {
        lastWire = "chat-completions";
        return sendOpenAi(target, model, payload, maxTokens, "openai-chat");
      }
      throw error;
    }
  };
  try {
    return await deliver(messages);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    // 部分兼容端点不认 cache_control：一次性剥除断点重试并全局降级（保持同一 run 内一致）。
    if (/cache_control|cache control|unexpected field/i.test(messageText) && cacheControlUnsupported === null) {
      cacheControlUnsupported = `${target.key}:${model}`;
      console.log(`[bench] cache_control rejected by ${target.key}; continuing without breakpoints`);
      return deliver(stripCacheControl(messages));
    }
    throw error;
  }
}

async function resolveModel(target: Target): Promise<string> {
  let lastError: unknown;
  const probe: ModelInputMessage[] = [{ role: "user", content: "ping" }];
  for (const model of target.models) {
    try {
      await send(target, model, probe, 32);
      return model;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no model available");
}

// ---------- 单次 run ----------

interface RequestRecord {
  phase: "pre" | "compact" | "post";
  turn: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  outputTokens: number;
}

function project(entries: readonly RuntimeMessageEntry[], layout: "legacy" | "anchored", skipCacheWrite = false) {
  return buildProviderRequestMessages({
    entries,
    applyCacheControl: true,
    skipCacheWrite,
    useMidConversationSystem: false,
    cacheLayout: layout,
  }).messages;
}

async function runOnce(
  target: Target,
  preset: (typeof AGENT_CONTEXT_PRESETS)[number],
): Promise<Record<string, unknown>> {
  const presetConfig = resolveContextPreset(preset);
  const { doc, sections } = buildHandbook();
  const records: RequestRecord[] = [];
  const probeResults: Array<{ module: string; expectedPort: number; answeredPort: number | null; raw: string }> = [];
  let history = buildInitialHistory(doc, `${target.key}-${preset}-${Date.now()}`);

  const askTurn = async (phase: "pre" | "post", turn: number, prompt: string, maxTokens = 700) => {
    history = [...history, userEntry(prompt)];
    const messages = project(history, presetConfig.cacheLayout);
    const result = await send(target, model!, messages, maxTokens);
    records.push({
      phase,
      turn,
      inputTokens: result.usage.input,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      outputTokens: result.usage.output,
    });
    history = [...history, assistantEntry(result.text.trim() || "(empty)")];
    return result.text;
  };

  // 模型探测（最小请求确认模型名可用）。
  const model = await resolveModel(target);
  activePromptCacheKey = `bench-${target.key}-${preset}-${Date.now()}`;

  // 压缩前：多轮问答，问题覆盖不同 section，让历史自然增长。
  for (let turn = 1; turn <= PRE_TURNS; turn += 1) {
    const section = sections[(turn * 5 - 1) % sections.length]!;
    await askTurn("pre", turn, `Question ${turn}: According to the handbook, which port does ${section.module} use? Answer with the exact number only.`);
  }

  // 手动压缩：完全复用产品选择/模板/重建代码路径。
  const preCompactTokens = estimateRuntimeEntryTokens(history, { useMidConversationSystem: false });
  const selection = selectCompactEntries({
    entries: history,
    trigger: "manual" as never,
    retention:
      presetConfig.retention.kind === "legacy-groups"
        ? undefined
        : {
            strategy: presetConfig.retention,
            effectiveContextWindow: target.contextWindow,
            summaryMaxTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
            useMidConversationSystem: false,
          },
  });
  const compactPrompt = buildCompactPrompt(undefined, presetConfig.summaryTemplate);
  const summaryRequestEntries = [
    ...selection.entriesForSummary,
    { message: { role: "user" as const, content: compactPrompt } },
  ];
  const summaryMessages = project(summaryRequestEntries, presetConfig.cacheLayout, true);
  const summaryResult = await send(target, model, summaryMessages, Math.min(6_000, MAX_OUTPUT_TOKENS_FOR_SUMMARY));
  records.push({
    phase: "compact",
    turn: 0,
    inputTokens: summaryResult.usage.input,
    cacheRead: summaryResult.usage.cacheRead,
    cacheWrite: summaryResult.usage.cacheWrite,
    outputTokens: summaryResult.usage.output,
  });
  const summary = formatCompactSummary(summaryResult.text) || summaryResult.text;

  // fused 预设的 transcript 回读：落盘压缩前原文，摘要消息携带路径。
  let transcriptPath: string | undefined;
  if (presetConfig.transcriptReference) {
    transcriptPath = join(RESULTS_DIR, `transcript-${target.key}-${preset}.txt`);
    writeFileSync(
      transcriptPath,
      history.map((entry) => JSON.stringify("message" in entry ? entry.message : entry.metadata)).join("\n"),
    );
  }
  const summaryEntry: RuntimeMessageEntry = {
    message: {
      role: "user",
      content: buildCompactSummaryMessage(summary, {
        suppressFollowup: true,
        preamble: presetConfig.summaryPreamble,
        ...(transcriptPath ? { transcriptPath } : {}),
      }),
    },
    metadata: {
      ...legacySyntheticRuntimeMetadata(),
      compactBoundary: { boundaryId: `bench-${Date.now()}` } as never,
    },
  };
  const postReminderEntries: RuntimeMessageEntry[] = presetConfig.injectTodoAfterCompact
    ? [
        systemReminderAttachmentEntry(
          "todo_reminder",
          "The conversation context was just compacted. The current todo list is preserved below; keep it accurate with the TodoWrite tool.\n\n[1. [in_progress] Answer handbook recall questions\n2. [pending] Summarize port allocations\n3. [pending] Draft migration note]",
        ),
      ]
    : [];
  const compactedHistory = buildPostCompactRuntimeEntries(history, summaryEntry, {
    preservedEntries: selection.preservedEntries,
    postCompactReminderEntries: postReminderEntries,
    summaryPosition: presetConfig.summaryPosition,
  });
  const postCompactTokens = estimateRuntimeEntryTokens(compactedHistory, {
    useMidConversationSystem: false,
  });
  history = compactedHistory;

  // 压缩后：对「已被压缩掉的早期 section」做回忆探针 + 1 个新问题。
  const earlyIndex = [1, 5, 10].map((i) => Math.min(i, sections.length - 1));
  const earlySections = earlyIndex.map((i) => sections[i]!);
  for (let turn = 1; turn <= POST_TURNS; turn += 1) {
    const section = earlySections[turn - 1]!;
    const answer = await askTurn(
      "post",
      turn,
      `According to the handbook from earlier in this conversation, which port does ${section.module} use? Answer from the conversation context only with the exact number. Do not say you cannot find it and do not ask me to re-paste anything.`,
    );
    const portMatch = answer.match(/\b51\d{3}\b/);
    probeResults.push({
      module: section.module,
      expectedPort: section.port,
      answeredPort: portMatch ? Number(portMatch[0]) : null,
      raw: answer.slice(0, 200),
    });
  }

  // usage 口径自适应：GLM 三桶不相交（input 不含 cacheRead），Anthropic 官方 input 含 cache。
  // 分母统一为「计费 prompt 总量」，两种口径都正确。
  const billedInput = (r: RequestRecord) =>
    r.cacheRead + r.cacheWrite <= r.inputTokens * 1.001
      ? r.inputTokens
      : r.inputTokens + r.cacheRead + r.cacheWrite;
  const totalInput = records.reduce((sum, r) => sum + billedInput(r), 0);
  const totalRead = records.reduce((sum, r) => sum + r.cacheRead, 0);
  const postRecords = records.filter((r) => r.phase === "post");
  const firstPost = records.find((r) => r.phase === "post");
  return {
    target: target.key,
    model,
    preset,
    wire: lastWire,
    promptCacheKey: target.promptCacheKey === true,
    summaryTemplate: presetConfig.summaryTemplate,
    requests: records,
    totals: {
      requests: records.length,
      inputTokens: totalInput,
      cacheRead: totalRead,
      cacheWrite: records.reduce((sum, r) => sum + r.cacheWrite, 0),
      hitRate: totalInput > 0 ? totalRead / totalInput : 0,
    },
    preCompactOnly: (() => {
      const pre = records.filter((r) => r.phase === "pre");
      const input = pre.reduce((sum, r) => sum + billedInput(r), 0);
      const read = pre.reduce((sum, r) => sum + r.cacheRead, 0);
      return { inputTokens: input, cacheRead: read, hitRate: input > 0 ? read / input : 0 };
    })(),
    postCompact: {
      firstTurnHitRate:
        firstPost && billedInput(firstPost) > 0
          ? firstPost.cacheRead / billedInput(firstPost)
          : 0,
      aggregateHitRate: (() => {
        const input = postRecords.reduce((sum, r) => sum + billedInput(r), 0);
        const read = postRecords.reduce((sum, r) => sum + r.cacheRead, 0);
        return input > 0 ? read / input : 0;
      })(),
    },
    compaction: {
      preCompactTokens,
      postCompactTokens,
      reductionRatio: preCompactTokens > 0 ? 1 - postCompactTokens / preCompactTokens : 0,
      preservedEntries: selection.preservedEntries.length,
      groupsPreserved: selection.groupsPreserved,
      summaryOutputTokens: summaryResult.usage.output,
    },
    recallProbes: probeResults,
    recallAccuracy:
      probeResults.length > 0
        ? probeResults.filter((p) => p.answeredPort === p.expectedPort).length / probeResults.length
        : 0,
  };
}

describe.skipIf(!process.env.ZCODE_LIVE_BENCH)("context preset live bench", () => {
  const targets = resolveTargets();

  it("runs every preset against every configured model", { timeout: 3_600_000 }, async () => {
    expect(targets.length).toBeGreaterThan(0);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const results: unknown[] = [];
    const errors: unknown[] = [];
    const presetFilter = (process.env.ZCODE_BENCH_PRESETS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const presets = presetFilter.length > 0 ? AGENT_CONTEXT_PRESETS.filter((p) => presetFilter.includes(p)) : [...AGENT_CONTEXT_PRESETS];
    const reps = Math.max(1, Number(process.env.ZCODE_BENCH_REPS ?? 1));
    const stamp = process.env.ZCODE_BENCH_STAMP ?? new Date().toISOString();
    const flush = () =>
      writeFileSync(
        join(RESULTS_DIR, `live-${stamp.replace(/[:.]/g, "-")}.json`),
        JSON.stringify({ results, errors, cacheControlUnsupported }, null, 2),
      );
    // rep 在外层交错执行，摊平后端随时间的漂移；结果带 rep 标记。
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const target of targets) {
        for (const preset of presets) {
          const startedAt = Date.now();
          try {
            const result = await runOnce(target, preset);
            results.push({ ...result, rep, durationMs: Date.now() - startedAt });
            console.log(
              `[bench] rep${rep} ${target.key}/${preset}: hit=${((result.totals as { hitRate: number }).hitRate * 100).toFixed(1)}% postFirst=${((result.postCompact as { firstTurnHitRate: number }).firstTurnHitRate * 100).toFixed(1)}% recall=${(result.recallAccuracy as number) * 100}% wire=${result.wire}`,
            );
          } catch (error) {
            errors.push({ target: target.key, preset, rep, error: String(error).slice(0, 500) });
            console.log(`[bench] rep${rep} ${target.key}/${preset} FAILED: ${String(error).slice(0, 300)}`);
          }
          flush();
        }
      }
    }
    console.log(`[bench] results written to ${RESULTS_DIR}`);
    expect(errors.length).toBe(0);
  });
});

