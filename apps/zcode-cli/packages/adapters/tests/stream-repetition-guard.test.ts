import { describe, expect, it } from "vitest";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import type { ModelNetworkStatusEvent, ModelStreamEvent } from "@zcode/contracts";
import {
  createStreamRepetitionGuardState,
  feedStreamRepetitionGuard,
  feedTextDeltasIntoRepetitionGuard,
  resolveStreamRepetitionGuardEnabled,
  STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS,
  STREAM_REPETITION_GUARD_WALL_MIN_REPEATS,
} from "../src/model/stream-repetition-guard.js";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";
import { executeAdapterStreamText } from "./test-adapter-model.js";

const SUMMARY_BLOCK = "## 完成 ✅ 原型 Demo 已全部交付，构建、交互、视觉、移动端全部验证通过。\n";

function feedAll(state: ReturnType<typeof createStreamRepetitionGuardState>, text: string, chunkSize = 64) {
  let detection: ReturnType<typeof feedStreamRepetitionGuard> = undefined;
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    detection = feedStreamRepetitionGuard(state, text.slice(offset, offset + chunkSize)) ?? detection;
    if (detection) break;
  }
  return detection;
}

describe("stream repetition guard detector", () => {
  it("detects a repeated summary block and keeps one copy", () => {
    const intro = "所有工具调用已完成，下面是最终总结。\n";
    const state = createStreamRepetitionGuardState(true);
    const detection = feedAll(state, intro + SUMMARY_BLOCK.repeat(9));

    expect(detection).toBeDefined();
    expect(detection?.unitContainsNewline).toBe(true);
    expect(detection?.repeatCount).toBeGreaterThanOrEqual(STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS);
    // 周期边界向前扩展时，前缀末尾与块尾的巧合字符（"。\n"）可能被一并划入重复区，
    // 因此断言行为契约而非精确下标：裁剪后恰好保留一份总结块，且第二份被完整丢弃。
    const kept = (intro + SUMMARY_BLOCK.repeat(9)).slice(0, detection?.trimToIndex ?? 0);
    expect(kept.length).toBeGreaterThan(intro.length);
    expect(kept.length).toBeLessThanOrEqual(intro.length + SUMMARY_BLOCK.length);
    expect(kept.split("## 完成").length - 1).toBe(1);
  });

  it("detects a no-newline dash wall and drops it entirely", () => {
    const prefix = "任务完成，收尾说明如下：";
    const state = createStreamRepetitionGuardState(true);
    const detection = feedAll(state, prefix + "— ".repeat(300));

    expect(detection).toBeDefined();
    expect(detection?.unitContainsNewline).toBe(false);
    expect(detection?.repeatCount).toBeGreaterThanOrEqual(STREAM_REPETITION_GUARD_WALL_MIN_REPEATS);
    expect(detection?.trimToIndex).toBe(prefix.length);
  });

  it("does not fire on normal prose with markdown rules and tables", () => {
    const section = (index: number) => [
      `## 第 ${index} 节`,
      "",
      `正文段落 ${index}，说明第 ${index} 部分的实现方式与取舍，内容各不相同。`,
      "",
      "----------",
      "",
      "| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 |",
      "|---|---|---|---|---|---|",
      `| ${index}a | ${index}b | ${index}c | ${index}d | ${index}e | ${index}f |`,
      "",
      `结尾段落 ${index}。`,
      "",
    ].join("\n");
    const doc = [section(1), section(2), section(3), section(4)].join("");
    expect(doc.length).toBeGreaterThan(512);
    const state = createStreamRepetitionGuardState(true);
    expect(feedAll(state, doc)).toBeUndefined();
  });

  it("does not fire below the repeat threshold", () => {
    const state = createStreamRepetitionGuardState(true);
    expect(feedAll(state, SUMMARY_BLOCK.repeat(3))).toBeUndefined();
  });

  it("stays accurate when the window slides past a long varied prefix", () => {
    const varied = Array.from(
      { length: 400 },
      (_, index) => `第 ${index} 行：各不相同的说明内容 ${index * 7}。\n`,
    ).join("");
    const state = createStreamRepetitionGuardState(true);
    const detection = feedAll(state, varied + SUMMARY_BLOCK.repeat(12));

    expect(detection).toBeDefined();
    const kept = (varied + SUMMARY_BLOCK.repeat(12)).slice(0, detection?.trimToIndex ?? 0);
    expect(kept.startsWith(varied.slice(0, -2))).toBe(true);
    expect(kept.split("## 完成").length - 1).toBeLessThanOrEqual(1);
  });

  it("locks after first detection and ignores further input", () => {
    const state = createStreamRepetitionGuardState(true);
    const first = feedAll(state, SUMMARY_BLOCK.repeat(9));
    expect(first).toBeDefined();
    expect(feedStreamRepetitionGuard(state, SUMMARY_BLOCK.repeat(9))).toBeUndefined();
  });

  it("is inert when disabled", () => {
    const state = createStreamRepetitionGuardState(false);
    expect(feedAll(state, SUMMARY_BLOCK.repeat(20))).toBeUndefined();
  });

  it("does not fire on a polling-loop script source (the echoed line appears once)", () => {
    // 轮询等待的正经写法：bash for 循环，echo 文案在「源码」里只出现一次，
    // 循环是控制结构，不构成文本重复；运行期的重复输出属于工具输出，不经过 text_delta。
    const script = [
      "# 等待后台构建完成，每 30 秒检查一次，最多 20 次",
      "# 用法：bash wait-for-build.sh，完成时退出码 0，超时退出码 1",
      "for i in $(seq 1 20); do",
      '  if check_task_done; then',
      '    echo "任务已完成，退出等待循环"',
      "    break",
      "  fi",
      '  echo "任务尚未完成，30 秒后重试"',
      "  sleep 30",
      "done",
      'echo "等待结束，汇总结果"',
      "# 脚本结束。运行期的重复 echo 属于工具输出，不会进入模型 text_delta 通道。",
    ].join("\n");
    expect(script.length).toBeGreaterThan(256);
    const state = createStreamRepetitionGuardState(true);
    expect(feedAll(state, script)).toBeUndefined();
  });

  it("requires 200+ chars of evidence, so a short polling line quoted ~12 times stays intact", () => {
    // 边界加固依据：用户场景「一条消息里同文案短行反复出现」。短行（15 字符）即使
    // 满足份数阈值，也要连续铺满 200 字符（约 13~14 行）才触发，少量引用不误杀。
    const line = "任务尚未完成，30 秒后重试\n";
    const prefix = "开始等待后台任务，下面是进度输出：\n";
    const state = createStreamRepetitionGuardState(true);
    expect(feedAll(state, prefix + line.repeat(12))).toBeUndefined();
  });

  it("still fires when identical short lines genuinely pile up in one message", () => {
    const line = "任务尚未完成，30 秒后重试\n";
    const prefix = "开始等待后台任务，下面是进度输出：\n";
    const state = createStreamRepetitionGuardState(true);
    const detection = feedAll(state, prefix + line.repeat(20));
    expect(detection).toBeDefined();
    const kept = (prefix + line.repeat(20)).slice(0, detection?.trimToIndex ?? 0);
    expect(kept.length).toBeGreaterThan(prefix.length);
    // 裁剪后最多保留一个检测单元（这里单元跨 2 行）。
    expect(kept.slice(prefix.length).split("任务尚未完成").length - 1).toBeLessThanOrEqual(2);
  });

  it("tolerates echoing a repetitive file inside a code fence (evidence floor ×4)", () => {
    // 用户让模型读取并回显含逐字相同行的文件（如重复错误日志）：回显落在 ``` 围栏内，
    // 重复是输入事实而非模型退化。围栏内证据下限 800 字符；chunk=8 验证跨 delta
    // 拆分的 ``` 围栏计数不漏计（若漏计会退回 200 下限导致触发）。
    const logLine = "ERROR [worker-3] connection refused\n";
    const echoed = "文件内容如下：\n```\n" + logLine.repeat(12) + "\n```\n";
    const state = createStreamRepetitionGuardState(true);
    expect(feedAll(state, echoed, 8)).toBeUndefined();
  });

  it("still bounds runaway repetition inside a code fence", () => {
    const logLine = "ERROR [worker-3] connection refused\n";
    const echoed = "```\n" + logLine.repeat(40) + "\n```\n";
    const state = createStreamRepetitionGuardState(true);
    const detection = feedAll(state, echoed, 8);
    expect(detection).toBeDefined();
    expect(detection?.repeatCount).toBeGreaterThanOrEqual(STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS);
  });

  it("applies the stricter floor to unfenced prose with the same content", () => {
    // 同样 12 行相同内容，不在围栏内（散文退化形态）按 200 字符下限正常触发，
    // 证明围栏感知收窄的是「回显」而不是普遍放宽。
    const logLine = "ERROR [worker-3] connection refused\n";
    const prose = "开始输出：\n" + logLine.repeat(12);
    const state = createStreamRepetitionGuardState(true);
    expect(feedAll(state, prose)).toBeDefined();
  });

  it("feeds only text deltas; tool input and reasoning never reach the detector", () => {    // 轮询等待的真实通道：工具入参（Write 写脚本）与 reasoning 都可能含有重复内容，
    // 但它们不是 text_delta，护栏完全不感知；工具输出则根本不经过模型流事件。
    const state = createStreamRepetitionGuardState(true);
    const repeated = SUMMARY_BLOCK.repeat(30);
    const nonTextEvents = [
      { type: "reasoning_delta", id: "r1", text: repeated },
      { type: "tool_input_start", id: "call-1", toolName: "Write" },
      { type: "tool_input_delta", id: "call-1", delta: repeated },
      { type: "tool_input_end", id: "call-1" },
      { type: "finish", finishReason: "stop", usage: {} },
    ] as unknown as import("@zcode/contracts").ModelStreamEvent[];
    expect(feedTextDeltasIntoRepetitionGuard(state, nonTextEvents)).toBeUndefined();
    expect(state.buffer).toBe("");

    // text_delta 正常喂入（未达阈值不触发，但缓冲区必须增长）。
    expect(
      feedTextDeltasIntoRepetitionGuard(state, [
        { type: "text_delta", text: "正常的一句说明文本，不构成任何重复模式。" },
      ] as unknown as import("@zcode/contracts").ModelStreamEvent[]),
    ).toBeUndefined();
    expect(state.buffer.length).toBeGreaterThan(0);
  });
});

describe("resolveStreamRepetitionGuardEnabled", () => {
  it("defaults to enabled and only recognizes explicit disable values", () => {
    expect(resolveStreamRepetitionGuardEnabled({})).toBe(true);
    expect(resolveStreamRepetitionGuardEnabled({ ZCODE_MODEL_STREAM_REPETITION_GUARD: "0" })).toBe(false);
    expect(resolveStreamRepetitionGuardEnabled({ ZCODE_MODEL_STREAM_REPETITION_GUARD: "false" })).toBe(false);
    expect(resolveStreamRepetitionGuardEnabled({ ZCODE_MODEL_STREAM_REPETITION_GUARD: " off " })).toBe(false);
    expect(resolveStreamRepetitionGuardEnabled({ ZCODE_MODEL_STREAM_REPETITION_GUARD: "1" })).toBe(true);
    expect(resolveStreamRepetitionGuardEnabled({ ZCODE_MODEL_STREAM_REPETITION_GUARD: "unexpected" })).toBe(true);
  });
});

describe("stream repetition guard runner integration", () => {
  it("stops a repeating stream with a synthetic finish marker and no retry", async () => {
    let attempts = 0;
    let providerFinishReached = false;
    async function* repeatingStream() {
      yield { type: "start" };
      yield { type: "text-start", id: "text-1" };
      for (let index = 0; index < 40; index += 1) {
        yield { type: "text-delta", id: "text-1", text: SUMMARY_BLOCK };
      }
      providerFinishReached = true;
      yield { type: "finish", finishReason: "stop", totalUsage: usage(10, 10) };
    }
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return { fullStream: repeatingStream() } as never;
      },
    };
    const adapter = new TestAiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          test: {
            kind: "custom",
            createLanguageModel: (modelId) => ({ modelId }) as never,
          },
        },
      }),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const events: ModelStreamEvent[] = [];
    const statusEvents: ModelNetworkStatusEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Wrap up" }],
      statusSink: {
        publish(event) {
          statusEvents.push(event);
        },
      },
    })) {
      events.push(event);
    }

    expect(attempts).toBe(1);
    expect(providerFinishReached).toBe(false);
    const finish = events[events.length - 1];
    expect(finish?.type).toBe("finish");
    if (finish?.type !== "finish") throw new Error("unreachable");
    expect(finish.finishReason).toBe("stop");
    expect(finish.usage).toEqual({});
    const marker = finish.providerMetadata?.streamRepetitionGuard as Record<string, unknown>;
    expect(marker?.repeatCount).toBeGreaterThanOrEqual(STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS);
    expect(typeof marker?.trimToIndex).toBe("number");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(statusEvents.some((event) => event.type === "model_stream_repetition_stopped")).toBe(true);
    expect(statusEvents.some((event) => event.type === "model_request_completed")).toBe(true);
    expect(statusEvents.some((event) => event.type === "model_retry_scheduled")).toBe(false);
    expect(statusEvents.some((event) => event.type === "model_request_failed")).toBe(false);
  });

  it("is fully bypassed when disabled", async () => {
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return {
          fullStream: stream([
            { type: "start" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", text: SUMMARY_BLOCK.repeat(12) },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: "stop", totalUsage: usage(2, 2) },
          ]),
        } as never;
      },
    };
    const adapter = new TestAiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          test: {
            kind: "custom",
            createLanguageModel: (modelId) => ({ modelId }) as never,
          },
        },
      }),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
      streamRepetitionGuardEnabled: false,
    });

    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test",
      modelId: "model-a",
      messages: [{ role: "user", content: "Wrap up" }],
    })) {
      events.push(event);
    }

    expect(attempts).toBe(1);
    const finish = events[events.length - 1];
    expect(finish?.type).toBe("finish");
    if (finish?.type !== "finish") throw new Error("unreachable");
    expect(finish.providerMetadata?.streamRepetitionGuard).toBeUndefined();
  });
});

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}
