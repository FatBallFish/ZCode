import type { NormalizedPet, NormalizedPetAnimation } from "./pets.js";

/**
 * 宠物动画引擎（纯逻辑，specs/desktop/desktop-pet.md）：按 NormalizedPet.animations 播放
 * 帧序列；loop=false 的动作播完落到 fallback。桌面宠物页与设置页卡片动图共用。
 */

export interface PetAnimator {
  /** 切换动作；不存在的动作忽略（保持当前）。 */
  play(name: string): void;
  /** 推进时间，返回当前应绘制的 sprite 索引。 */
  tick(nowMs: number): number;
  /** 当前动作名。 */
  readonly current: string;
}

export function createPetAnimator(pet: NormalizedPet, initial = "idle"): PetAnimator {
  let current = pet.animations[initial] ? initial : "idle";
  let elapsed = 0;
  let lastNow: number | undefined;

  const totalDuration = (animation: NormalizedPetAnimation) =>
    animation.frames.reduce((total, frame) => total + frame.durationMs, 0);

  const frameAt = (animation: NormalizedPetAnimation, time: number): number => {
    let cursor = 0;
    for (const frame of animation.frames) {
      cursor += frame.durationMs;
      if (time < cursor) return frame.spriteIndex;
    }
    return animation.frames[animation.frames.length - 1]!.spriteIndex;
  };

  return {
    play(name) {
      if (!pet.animations[name] || name === current) return;
      current = name;
      elapsed = 0;
      lastNow = undefined;
    },
    get current() {
      return current;
    },
    tick(nowMs) {
      if (lastNow === undefined) lastNow = nowMs;
      const delta = Math.max(0, Math.min(nowMs - lastNow, 1000));
      lastNow = nowMs;
      let animation = pet.animations[current] ?? pet.animations["idle"]!;
      elapsed += delta;
      const duration = totalDuration(animation);
      if (elapsed >= duration) {
        if (animation.loop) {
          elapsed = elapsed % Math.max(duration, 1);
        } else {
          // 一次性动作播完 → fallback（默认 idle），不重播一次性动作。
          const fallback = pet.animations[animation.fallback] ? animation.fallback : "idle";
          elapsed = elapsed % Math.max(duration, 1);
          current = fallback;
          animation = pet.animations[current]!;
          elapsed = elapsed % Math.max(totalDuration(animation), 1);
        }
      }
      return frameAt(animation, elapsed);
    },
  };
}

/** 拖拽方向 → 动作名（水平分量优先；v1/v2 网格里左右跑同名行）。
 * 竖直方向（上/下）统一用循环动作 running：jumping 是一次性 ×3 动作，
 * 持续竖直拖拽会在动作播完后落回 idle，看起来像动画中断。 */
export function dragAnimationName(dx: number, dy: number): string {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "running-right" : "running-left";
  return "running";
}

/** 按运行态事件映射动作（agent running / 问候 waving / 默认 idle）。 */
export function stateAnimationName(state: "idle" | "running" | "waving"): string {
  return state;
}

/**
 * 会话摘要 → 宠物动作（specs/desktop/desktop-pet.md 会话状态气泡）。
 * 动作名沿用官方网格行名，但按「视觉语义」选择（官方图集实测）：
 * 第 6 行 waiting = 对着笔记本电脑敲击（工作中的视觉），第 7 行 running = 原地小跑，
 * 第 8 行 review = 举放大镜检查，第 5 行 failed = 垂头。
 * 会话进行中应呈现"工作"而非"跑步"；等待用户用原地小跑表达催促。
 * 优先级：任一 waiting → running（催促）；否则任一 running → waiting（工作）；
 * 否则 error+未读 → failed；否则 completed+未读 → review；否则 idle。
 * agentRunningTotal 是无摘要时的兜底。
 */
export function resolvePetAnimationState(
  summaries: readonly { liveStatus: string; unread: boolean }[],
  agentRunningTotal: number,
): "idle" | "running" | "waiting" | "failed" | "review" {
  if (summaries.some((item) => item.liveStatus === "waiting")) return "running";
  if (summaries.some((item) => item.liveStatus === "running")) return "waiting";
  if (summaries.some((item) => item.liveStatus === "error" && item.unread)) return "failed";
  if (summaries.some((item) => item.liveStatus === "completed" && item.unread)) return "review";
  if (agentRunningTotal > 0) return "waiting";
  return "idle";
}
