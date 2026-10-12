import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createChatGPTResponsesTransportFetch,
  transformResponsesBody,
  CHATGPT_SERVICE_TIER_HEADER,
} from "../src/model/chatgpt-responses-transport.js";
import {
  reportChatGPTRequestOutcome,
  setChatGPTRequestOutcomeReporter,
  type ChatGPTRequestOutcomeReporter,
} from "../src/model/chatgpt-outcome-reporter.js";

test("Responses 请求体改写：store/stream 强制、裁剪不支持字段、include 加密 reasoning", () => {
  const body = JSON.stringify({
    model: "gpt-5.3-codex",
    input: "你好",
    temperature: 1,
    max_output_tokens: 4096,
    top_p: 1,
    user: "u",
    stream_options: { include_usage: true },
    reasoning: { effort: "minimal", summary: "auto" },
    service_tier: "auto",
  });
  const transformed = JSON.parse(
    transformResponsesBody(body, "flex") as string,
  ) as Record<string, unknown>;
  assert.equal(transformed.store, false);
  assert.equal(transformed.stream, true);
  assert.equal(transformed.temperature, undefined);
  assert.equal(transformed.max_output_tokens, undefined);
  assert.equal(transformed.top_p, undefined);
  assert.equal(transformed.user, undefined);
  assert.equal(transformed.stream_options, undefined);
  assert.deepEqual(transformed.input, [
    { type: "message", role: "user", content: "你好" },
  ]);
  assert.deepEqual(transformed.include, ["reasoning.encrypted_content"]);
  assert.equal(
    (transformed.reasoning as { effort?: string }).effort,
    "none",
    "minimal 归一为 none",
  );
  assert.equal(transformed.service_tier, "flex");
});

test("service_tier 策略：auto 删除；fast 归一 priority", () => {
  const auto = JSON.parse(transformResponsesBody(JSON.stringify({ service_tier: "x" }), "auto") as string);
  assert.equal(auto.service_tier, undefined);
  const fast = JSON.parse(transformResponsesBody("{}", "fast") as string);
  assert.equal(fast.service_tier, "priority");
});

test("非 JSON body 原样透传", () => {
  assert.equal(transformResponsesBody("not-json", "auto"), "not-json");
});

test("transport fetch：剥离私有 tier 头、CF cookie 回放、401 上报 auth-error", async () => {
  const outcomes: unknown[] = [];
  const reporter: ChatGPTRequestOutcomeReporter = (outcome) => outcomes.push(outcome);
  setChatGPTRequestOutcomeReporter(reporter);
  let seenHeaders: Headers | null = null;
  let seenBody = "";
  const fetchMock = async (_input: unknown, init?: RequestInit) => {
    seenHeaders = new Headers(init?.headers);
    seenBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ error: { code: "token_invalidated" } }), {
      status: 401,
      headers: { "content-type": "application/json", "set-cookie": "__cf_bm=abc; Max-Age=60" },
    });
  };
  const transport = createChatGPTResponsesTransportFetch({
    providerId: "account:chatgpt:acc-1",
    request: fetchMock as typeof fetch,
  });
  const response = await transport("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer at",
      [CHATGPT_SERVICE_TIER_HEADER]: "fast",
      "chatgpt-account-id": "acc-1",
    },
    body: JSON.stringify({ model: "gpt-5.4", input: [] }),
  });
  assert.equal(response.status, 401);
  assert.equal(seenHeaders!.get(CHATGPT_SERVICE_TIER_HEADER), null, "私有载体头必须剥离");
  assert.equal(seenHeaders!.get("authorization"), "Bearer at");
  assert.equal(JSON.parse(seenBody).service_tier, "priority", "tier 头转请求体");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0] as { kind: string; providerId: string; status: number; errorCode?: string };
  assert.equal(outcome.kind, "auth-error");
  assert.equal(outcome.providerId, "account:chatgpt:acc-1");
  assert.equal(outcome.status, 401);
  assert.equal(outcome.errorCode, "token_invalidated");

  // CF cookie 在第二次请求回放。
  let secondCookie: string | null = null;
  const transport2 = createChatGPTResponsesTransportFetch({
    providerId: "account:chatgpt:acc-1",
    request: (async (_input: unknown, init?: RequestInit) => {
      secondCookie = new Headers(init?.headers).get("cookie");
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await transport2("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
  assert.match(secondCookie ?? "", /__cf_bm=abc/u, "白名单 cookie 应回放");
  setChatGPTRequestOutcomeReporter(undefined);
});

test("transport fetch：403 Cloudflare HTML 豁免上报；429 usage_limit_reached 上报 usage", async () => {
  const outcomes: unknown[] = [];
  setChatGPTRequestOutcomeReporter((outcome) => outcomes.push(outcome));

  const cfTransport = createChatGPTResponsesTransportFetch({
    providerId: "account:chatgpt:acc-2",
    request: (async () =>
      new Response("<html>blocked by cloudflare</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
  });
  await cfTransport("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(outcomes.length, 0, "CF HTML 403 不动账号状态");

  const rateLimitTransport = createChatGPTResponsesTransportFetch({
    providerId: "account:chatgpt:acc-2",
    request: (async () =>
      new Response(
        JSON.stringify({
          error: { type: "usage_limit_reached", plan_type: "plus", resets_at: 1893456000 },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
          },
        },
      )) as typeof fetch,
  });
  await rateLimitTransport("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const outcome = outcomes[0] as {
    kind: string;
    usageLimit?: { planType?: string };
    rateLimitHeaders?: { primary?: { usedPercent: number } };
  };
  assert.equal(outcome.kind, "usage");
  assert.equal(outcome.usageLimit?.planType, "plus");
  assert.equal(outcome.rateLimitHeaders?.primary?.usedPercent, 100);
  setChatGPTRequestOutcomeReporter(undefined);
});

test("reportChatGPTRequestOutcome：未注册 reporter 时不抛错", () => {
  setChatGPTRequestOutcomeReporter(undefined);
  assert.doesNotThrow(() => {
    reportChatGPTRequestOutcome({ providerId: "p", kind: "usage" });
  });
});
