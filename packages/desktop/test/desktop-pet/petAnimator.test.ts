import assert from "node:assert/strict";
import test from "node:test";
import { normalizePetManifest } from "@zcode/shared";
import {
  PET_CLICK_THRESHOLD_PX,
  createPetAnimator,
  createPetDragDirectionTracker,
  dragAnimationName,
} from "@zcode/shared";

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

// 2026-10-11 拖拽重构：方向迟滞迁到 main（按实际应用位移判定），语义与旧宠物页
// 一致——总位移 ≤ 点击阈值不判方向；新方向累计 ≥16px（或单步 ≥20px）且距上次
// 切换 ≥200ms 才切换；同方向持续不重复触发。
test("拖拽方向追踪：点击级位移不判方向；迟滞与间隔生效", () => {
  // 时间用 performance.now()/Date.now() 量级：lastDirectionAt 初始为 0，
  // 首次切换天然满足「距上次切换 ≥200ms」。
  const t0 = 60_000;
  const tracker = createPetDragDirectionTracker();
  assert.equal(tracker.push(3, 0, t0), undefined, "总位移 ≤6px 不判方向");
  assert.equal(tracker.push(3, 0, t0 + 10), undefined);
  assert.equal(tracker.movedPx, PET_CLICK_THRESHOLD_PX, "恰好等于阈值仍不判（严格大于才判）");
  // 累计 16px 同方向 → 切换 running-right。
  assert.equal(tracker.push(20, 0, t0 + 100), "running-right", "单步 ≥20px 立即切换");
  // 同方向继续推进不重复触发。
  assert.equal(tracker.push(30, 0, t0 + 200), undefined);
  // 反向但距上次切换 <200ms：不切换。
  assert.equal(tracker.push(-20, 0, t0 + 250), undefined, "间隔不足 200ms 不切换");
  // 反向且间隔足够 → 切换 running-left。
  assert.equal(tracker.push(-20, 0, t0 + 400), "running-left");
  // 小幅抖动（<16px 累计）不足以切换方向。
  assert.equal(tracker.push(5, 0, t0 + 600), undefined);
  assert.equal(tracker.push(5, 0, t0 + 700), undefined);
  assert.equal(tracker.push(5, 0, t0 + 800), undefined, "累计 15px <16px 且单步 <20px 不切换");
  assert.equal(tracker.push(5, 0, t0 + 900), "running-right", "累计 ≥16px 且间隔足够则切换");
  // clamp 边缘零位移：只累计 0，不产生方向。
  const clamped = createPetDragDirectionTracker();
  clamped.push(20, 0, t0);
  assert.equal(clamped.push(0, 0, t0 + 100), undefined);
  assert.equal(clamped.push(0, 0, t0 + 200), undefined);
});

test("拖拽方向追踪：movedPx 累计 hypot，供点击判定", () => {
  const tracker = createPetDragDirectionTracker();
  tracker.push(3, 4, 0);
  assert.equal(tracker.movedPx, 5);
});
