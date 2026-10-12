import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeChatGPTRateLimitHeadersIntoUsage,
  normalizeChatGPTUsagePayload,
  parseChatGPTRateLimitHeaders,
  parseChatGPTUsageLimitBody,
} from "../src/chatgpt-usage.js";

test("usage 归一：双窗口按 window_minutes 小者=5h、大者=7d", () => {
  const snapshot = normalizeChatGPTUsagePayload({
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 42, limit_window_seconds: 300 },
      secondary_window: {
        used_percent: 7,
        limit_window_seconds: 604800,
        reset_after_seconds: 5000,
      },
    },
    additional_rate_limits: [
      {
        limit_name: "image_gen",
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2592000 } },
      },
    ],
    credits: { has_credits: true, unlimited: false, balance: "12.50" },
  });
  assert.equal(snapshot.window5h?.usedPercent, 42);
  assert.equal(snapshot.window5h?.windowMinutes, 5);
  assert.equal(snapshot.window7d?.usedPercent, 7);
  assert.equal(snapshot.window7d?.windowMinutes, 10080);
  assert.equal(snapshot.additionalWindows.length, 1);
  assert.equal(snapshot.additionalWindows[0]?.name, "image_gen");
  assert.equal(snapshot.credits?.balance, "12.50");
  assert.equal(snapshot.limitReached, false);
});

test("usage 归一：单窗口 ≤360min 判 5h，无窗口返回空快照", () => {
  const single = normalizeChatGPTUsagePayload({
    rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 360 } },
  });
  assert.ok(single.window5h);
  assert.equal(single.window7d, undefined);

  // 366min > 360min 判 7d。
  const swapped = normalizeChatGPTUsagePayload({
    rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 21960 } },
  });
  assert.equal(swapped.window5h, undefined);
  assert.ok(swapped.window7d);

  const empty = normalizeChatGPTUsagePayload({});
  assert.equal(empty.window5h, undefined);
  assert.deepEqual(empty.additionalWindows, []);
});

test("限流头族解析：active-limit 前缀 + credits 头", () => {
  const headers = new Headers({
    "x-codex-active-limit": "codex_secondary",
    "x-codex-secondary-primary-used-percent": "95",
    "x-codex-secondary-primary-window-minutes": "300",
    "x-codex-secondary-primary-reset-at": "1893456000",
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-balance": "3",
    "x-codex-rate-limit-reached-type": "RateLimitReached",
  });
  const snapshot = parseChatGPTRateLimitHeaders(headers);
  assert.ok(snapshot);
  assert.equal(snapshot.activeLimit, "codex_secondary");
  assert.equal(snapshot.primary?.usedPercent, 95);
  assert.equal(snapshot.primary?.windowMinutes, 300);
  assert.equal(snapshot.hasCredits, true);
  assert.equal(snapshot.creditsBalance, "3");
  assert.equal(snapshot.rateLimitReachedType, "RateLimitReached");

  assert.equal(parseChatGPTRateLimitHeaders(new Headers()), undefined);
});

test("默认前缀回落：无 active-limit 时按 x-codex-primary/secondary 解析", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "30",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "60",
    "x-codex-secondary-window-minutes": "10080",
  });
  const snapshot = parseChatGPTRateLimitHeaders(headers);
  assert.ok(snapshot);
  assert.equal(snapshot.primary?.usedPercent, 30);
  assert.equal(snapshot.secondary?.usedPercent, 60);
});

test("头族合并进 usage 快照（被动更新只覆盖出现的字段）", () => {
  const base = normalizeChatGPTUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 42, limit_window_seconds: 300 },
      secondary_window: { used_percent: 7, limit_window_seconds: 604800 },
    },
    credits: { has_credits: false, unlimited: false },
  });
  const merged = mergeChatGPTRateLimitHeadersIntoUsage(base, {
    primary: { usedPercent: 55, windowMinutes: 5 },
    hasCredits: true,
  });
  assert.equal(merged.window5h?.usedPercent, 55, "仅覆盖出现的 5h 窗口");
  assert.equal(merged.window7d?.usedPercent, 7, "7d 窗口保留");
  assert.equal(merged.credits?.hasCredits, true);

  const fromScratch = mergeChatGPTRateLimitHeadersIntoUsage(undefined, {
    primary: { usedPercent: 10 },
  });
  assert.equal(fromScratch.window5h?.usedPercent, 10);
});

test("429 usage_limit_reached 体解析", () => {
  const parsed = parseChatGPTUsageLimitBody(
    JSON.stringify({
      error: {
        type: "usage_limit_reached",
        plan_type: "plus",
        resets_at: 1893456000,
        limit_window_minutes: 300,
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.planType, "plus");
  assert.equal(parsed.limitWindowMinutes, 300);
  assert.equal(parsed.resetsAt, "2030-01-01T00:00:00.000Z");
  assert.equal(parseChatGPTUsageLimitBody("not-json"), undefined);
  assert.equal(parseChatGPTUsageLimitBody(JSON.stringify({})), undefined);
});

test("credits 余额展示格式化：去掉多余小数、非整数保留两位、异常值原样返回", async () => {
  const { formatChatGPTCreditsBalance } = await import("../src/chatgpt-usage.js");
  assert.equal(formatChatGPTCreditsBalance("62500.0000000000"), "62500");
  assert.equal(formatChatGPTCreditsBalance("62500.5000000000"), "62500.5");
  assert.equal(formatChatGPTCreditsBalance("62500.125"), "62500.13");
  assert.equal(formatChatGPTCreditsBalance("0.00"), "0");
  assert.equal(formatChatGPTCreditsBalance(""), null);
  assert.equal(formatChatGPTCreditsBalance(null), null);
  assert.equal(formatChatGPTCreditsBalance(undefined), null);
  assert.equal(formatChatGPTCreditsBalance("abc"), "abc");
});
