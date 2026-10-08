import assert from "node:assert/strict";
import test from "node:test";
import { normalizePetManifest } from "@zcode/shared";
import { createPetAnimator, dragAnimationName } from "@zcode/shared";

/** 宠物动画引擎：帧推进/循环/一次性动作回落 fallback/拖拽方向映射。 */

function buildPet() {
  const manifest = {
    id: "t",
    animations: {
      // 3 帧 × 100ms 循环，帧索引显式错开便于断言。
      idle: { frames: [10, 11, 12], fps: 10, loop: true },
      // 一次性，回落 idle。
      waving: { frames: [20, 21], fps: 10, loop: false, fallback: "idle" },
    },
  };
  const result = normalizePetManifest({
    manifest,
    fallbackId: "t",
    sheetWidth: 1536,
    sheetHeight: 1872,
  });
  assert.ok(result.ok);
  return result.pet;
}

test("循环动作按帧时长推进并回绕", () => {
  const animator = createPetAnimator(buildPet());
  assert.equal(animator.tick(0), 10);
  assert.equal(animator.tick(50), 10);
  assert.equal(animator.tick(120), 11);
  assert.equal(animator.tick(210), 12);
  assert.equal(animator.tick(310), 10, "3×100ms 后回绕到首帧");
});

test("一次性动作播完回落 fallback，不重播", () => {
  const animator = createPetAnimator(buildPet());
  animator.play("waving");
  assert.equal(animator.tick(0), 20);
  assert.equal(animator.tick(150), 21);
  assert.equal(animator.tick(350), 11, "waving 播完落回 idle（顺延 150ms → 第 2 帧）");
  // elapsed=150；再过 1100ms（单步钳制 1000ms）→ 1150%300=250 → 第 3 帧；再 +100ms 回绕第 1 帧。
  assert.equal(animator.tick(1450), 12);
  assert.equal(animator.tick(1550), 10);
});

test("不存在的动作忽略；相同动作不重置进度", () => {
  const animator = createPetAnimator(buildPet());
  animator.tick(0);
  animator.tick(150); // idle 第 2 帧
  animator.play("idle");
  animator.play("nope");
  assert.equal(animator.tick(160), 11, "play(idle) 不清零进度");
});

test("大步进（休眠唤醒）不会死循环，钳制在 1s", () => {
  const animator = createPetAnimator(buildPet());
  animator.tick(0);
  const index = animator.tick(60_000);
  assert.ok([10, 11, 12].includes(index));
});

test("拖拽方向映射：水平优先；竖直上/下统一循环 running", () => {
  assert.equal(dragAnimationName(5, 0), "running-right");
  assert.equal(dragAnimationName(-5, 0), "running-left");
  assert.equal(dragAnimationName(0, 5), "running");
  assert.equal(dragAnimationName(0, -5), "running", "竖直向上不用一次性 jumping");
  assert.equal(dragAnimationName(1, 10), "running");
});
