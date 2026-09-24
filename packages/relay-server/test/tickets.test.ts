import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAccessHash,
  hashDeviceToken,
  newOpaqueToken,
  newSessionId,
  verifyAccessHash,
} from "../src/tickets.js";

test("accessHash 由 secret+sid+mid+t 决定且可验证", () => {
  const hash = computeAccessHash("secret-1", "s_abc", "mid-1", 1000);
  assert.equal(hash, computeAccessHash("secret-1", "s_abc", "mid-1", 1000));
  assert.ok(verifyAccessHash("secret-1", "s_abc", "mid-1", 1000, hash));

  // 任一输入变化都应失配。
  assert.ok(!verifyAccessHash("secret-2", "s_abc", "mid-1", 1000, hash));
  assert.ok(!verifyAccessHash("secret-1", "s_other", "mid-1", 1000, hash));
  assert.ok(!verifyAccessHash("secret-1", "s_abc", "mid-2", 1000, hash));
  assert.ok(!verifyAccessHash("secret-1", "s_abc", "mid-1", 1001, hash));
  // 篡改/非法 base64 一律拒绝。
  assert.ok(!verifyAccessHash("secret-1", "s_abc", "mid-1", 1000, hash.slice(0, -2)));
  assert.ok(!verifyAccessHash("secret-1", "s_abc", "mid-1", 1000, "!!!not-base64!!!"));
});

test("sid 与 token 形状：s_ 前缀、足够熵、互不相同", () => {
  const sid = newSessionId();
  assert.match(sid, /^s_[A-Za-z0-9]{22}$/);
  const tokens = new Set(Array.from({ length: 64 }, () => newOpaqueToken()));
  assert.equal(tokens.size, 64);
  assert.ok(newOpaqueToken().length >= 40);
});

test("deviceToken 只以哈希形态可比对", () => {
  const token = newOpaqueToken();
  const hashed = hashDeviceToken(token);
  assert.notEqual(hashed, token);
  assert.equal(hashDeviceToken(token), hashed);
  assert.notEqual(hashDeviceToken("other"), hashed);
});
