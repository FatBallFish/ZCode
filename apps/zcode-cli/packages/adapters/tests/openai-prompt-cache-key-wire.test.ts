import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

/**
 * openai-responses wire 的 prompt_cache_key 门控（docs/specs/openai-responses-prompt-cache-key.md）：
 * 默认 auto = 仅 gpt 前缀模型发送；promptCacheKeyMode 按模型强制 on/off；
 * 请求显式 promptCacheKey 优先；anthropic/openai-compatible wire 不发送。
 */
describe("openai responses prompt_cache_key wire shape", () => {
  it("sends prompt_cache_key = sessionId for gpt models under auto mode", async () => {
    const capture = createRequestCapture();
    await runCapturedRequest(capture.fetch, {
      modelId: "gpt-6.1-sol",
      promptCacheKeyMode: undefined,
    });

    expect(capture.body().prompt_cache_key).toBe("sess_prompt_cache_wire_1");
  });

  it("omits prompt_cache_key for non-gpt models under auto mode", async () => {
    const capture = createRequestCapture();
    await runCapturedRequest(capture.fetch, {
      modelId: "deepseek-v4.1-flash",
      promptCacheKeyMode: undefined,
    });

    expect(capture.body().prompt_cache_key).toBeUndefined();
  });

  it("forces prompt_cache_key on for non-gpt models when mode is on", async () => {
    const capture = createRequestCapture();
    await runCapturedRequest(capture.fetch, {
      modelId: "deepseek-v4.1-flash",
      promptCacheKeyMode: "on",
    });

    expect(capture.body().prompt_cache_key).toBe("sess_prompt_cache_wire_1");
  });

  it("disables prompt_cache_key for gpt models when mode is off", async () => {
    const capture = createRequestCapture();
    await runCapturedRequest(capture.fetch, {
      modelId: "gpt-6.1-sol",
      promptCacheKeyMode: "off",
    });

    expect(capture.body().prompt_cache_key).toBeUndefined();
  });

  it("keeps an explicit request-level promptCacheKey over the session-derived key", async () => {
    const capture = createRequestCapture();
    await runCapturedRequest(capture.fetch, {
      modelId: "gpt-6.1-sol",
      promptCacheKeyMode: undefined,
      requestProviderOptions: { openai: { promptCacheKey: "explicit-key" } },
    });

    expect(capture.body().prompt_cache_key).toBe("explicit-key");
  });

  it("matches the gpt prefix case-insensitively", async () => {
    const capture = createRequestCapture();
    await runCapturedRequest(capture.fetch, {
      modelId: "GPT-7-Codex",
      promptCacheKeyMode: undefined,
    });

    expect(capture.body().prompt_cache_key).toBe("sess_prompt_cache_wire_1");
  });
});

async function runCapturedRequest(
  fetch: typeof globalThis.fetch,
  input: {
    modelId: string;
    promptCacheKeyMode: "auto" | "on" | "off" | undefined;
    requestProviderOptions?: Record<string, unknown>;
  },
): Promise<void> {
  const provider = createOpenAI({
    apiKey: "fake-key",
    baseURL: "https://api.example.test",
    fetch,
  });
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: {
      messages: [{ content: "hi", role: "user" as const }],
      ...(input.requestProviderOptions
        ? { providerOptions: input.requestProviderOptions }
        : {}),
    },
    resolved: {
      properties: createTestModelProperties(
        {},
        input.promptCacheKeyMode === undefined
          ? {}
          : { promptCacheKeyMode: input.promptCacheKeyMode },
      ),
      model: provider.responses(input.modelId),
      providerKind: "openai" as const,
      providerId: "openai",
      modelId: input.modelId,
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId: "openai",
      modelId: input.modelId,
      providerKind: "openai",
      requestId: `req_prompt_cache_${input.modelId}`,
      sessionId: "sess_prompt_cache_wire_1",
      traceId: `trace_prompt_cache_${input.modelId}`,
    } as never,
  });

  await expect(generateText(options)).rejects.toBeDefined();
}

function createRequestCapture(): {
  body: () => Record<string, unknown>;
  fetch: typeof globalThis.fetch;
} {
  let capturedBody: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    capturedBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(JSON.stringify({ error: { message: "wire capture", type: "test" } }), {
      headers: { "content-type": "application/json" },
      status: 400,
    });
  };

  return {
    body() {
      if (!capturedBody) {
        throw new Error("Expected the provider request body to be captured");
      }
      return capturedBody;
    },
    fetch,
  };
}
