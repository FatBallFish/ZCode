import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "../src/rateLimit.js";

function fixture(maxTokens = 3) {
  let now = 0;
  return {
    limiter: new RateLimiter(maxTokens, 1000, () => now),
    advance(ms: number) {
      now += ms;
    },
  };
}

test("桶满限流：超出 max 拒绝，窗口过后恢复，key 隔离", () => {
  const { limiter, advance } = fixture();
  assert.ok(limiter.allow("ip-1"));
  assert.ok(limiter.allow("ip-1"));
  assert.ok(limiter.allow("ip-1"));
  assert.ok(!limiter.allow("ip-1")); // 桶空。
  assert.ok(limiter.allow("ip-2")); // key 隔离。

  advance(1001);
  assert.ok(limiter.allow("ip-1"));
});

test("失败惩罚：strike 指数放大消耗", () => {
  const { limiter } = fixture(10);
  // 连续两次失败（不 reset）：惩罚 2 + 4 = 6，剩 4。
  limiter.strike("ip-1");
  limiter.strike("ip-1");
  let allowed = 0;
  while (limiter.allow("ip-1")) {
    allowed += 1;
  }
  assert.equal(allowed, 4);
});

test("成功后清除惩罚计数，下次 strike 重新从小惩罚开始", () => {
  const { limiter } = fixture(10);
  // 两次失败之间 reset：惩罚 2 + 2 = 4，剩 6。
  limiter.strike("ip-1");
  limiter.resetStrikes("ip-1");
  limiter.strike("ip-1");
  let allowed = 0;
  while (limiter.allow("ip-1")) {
    allowed += 1;
  }
  assert.equal(allowed, 6);
});
