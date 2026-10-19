import type { ModelStreamEvent } from "@zcode/contracts";
import type { EnvRecord } from "./model-execution.js";

/**
 * 流式重复退化护栏（spec: specs/agent/stream-repetition-guard.md）。
 *
 * 事故依据（sess_6db0845f，2026-10-17）：GLM-5.3 在 260k token 上下文的收尾纯文本
 * 阶段发生自回归退化——同一总结块连续重复 9 次后继续退化为破折号墙，流式输出
 * 252 秒无护栏干预，最终只能靠用户手动 Stop。idle timeout 只覆盖「无事件到达」，
 * 重复循环持续吐 delta，因此必须在文本累计层检测「尾部同单元连续铺满」。
 */

const STREAM_REPETITION_GUARD_MIN_UNIT_CHARS = 24;
const STREAM_REPETITION_GUARD_MAX_UNIT_CHARS = 2048;
/** 单元含换行（块级重复，事故主形态）需要的连续份数。 */
export const STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS = 4;
/** 单元不含换行（单行墙，如 `— — —` / `-----`）需要的连续份数。 */
export const STREAM_REPETITION_GUARD_WALL_MIN_REPEATS = 5;
/** 每累计多少新字符跑一次检测。 */
const STREAM_REPETITION_GUARD_CHECK_INTERVAL_CHARS = 256;
/**
 * 最小证据量（计数区 k×L 总字符数）。短行文案（如轮询进度叙述「任务尚未完成，30 秒后重试」
 * 约 15 字符/行）即使满足份数阈值，也要连续铺满 200 字符（约 13~14 行）才触发，
 * 避免误杀单条消息里少量引用的重复行；事故级块重复（KB 级单元）不受影响。
 */
const STREAM_REPETITION_GUARD_MIN_EVIDENCE_CHARS = 200;
/**
 * 代码围栏（```）内的最小证据量。用户让模型读取并回显含大量逐字相同内容的文件
 * （如重复错误日志）时，回显落在围栏里且重复是「输入事实」而非模型退化——事故
 * 退化形态是围栏外散文。围栏内放宽到 800 字符：既容下常规回显/刻意生成的重复
 * 数据，又保证围栏内退化仍有上界（800 字符通常数秒内到达）。
 */
const STREAM_REPETITION_GUARD_CODE_FENCE_MIN_EVIDENCE_CHARS = 800;
/** 检测窗口：必须容纳 MAX_UNIT × WALL_MIN_REPEATS 才能完整计数最大单元。 */
const STREAM_REPETITION_GUARD_WINDOW_CHARS =
  STREAM_REPETITION_GUARD_MAX_UNIT_CHARS * (STREAM_REPETITION_GUARD_WALL_MIN_REPEATS + 1);

const ENV_STREAM_REPETITION_GUARD = "ZCODE_MODEL_STREAM_REPETITION_GUARD";

export interface StreamRepetitionDetection {
  /** 触发时已累计的 text delta 总字符数（core 侧全量 text 的长度坐标）。 */
  totalChars: number;
  /** 裁剪目标：全量文本保留到该下标（块级保留 1 份单元，墙级全部丢弃）。 */
  trimToIndex: number;
  unitLength: number;
  repeatCount: number;
  unitContainsNewline: boolean;
}

export interface StreamRepetitionGuardState {
  readonly enabled: boolean;
  buffer: string;
  bufferStartIndex: number;
  charsSinceCheck: number;
  triggered: boolean;
  /** 当前是否处于未闭合的 ``` 围栏内（按增量计数维护，不受窗口淘汰影响）。 */
  fenceOpen: boolean;
  /** 跨 delta 检测被拆分的 ``` 标记所保留的尾部（最多 2 字符）。 */
  fenceCarry: string;
}

export function resolveStreamRepetitionGuardEnabled(env: EnvRecord): boolean {
  const raw = env[ENV_STREAM_REPETITION_GUARD]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export function createStreamRepetitionGuardState(enabled: boolean): StreamRepetitionGuardState {
  return {
    enabled,
    buffer: "",
    bufferStartIndex: 0,
    charsSinceCheck: 0,
    triggered: false,
    fenceOpen: false,
    fenceCarry: "",
  };
}

/**
 * 喂入一段 text delta；达到检测间隔时在滑动窗口尾部寻找「同单元连续铺满」。
 * 返回检测结果的本次调用即是触发点，之后状态锁定，不再重复触发。
 */
export function feedStreamRepetitionGuard(
  state: StreamRepetitionGuardState,
  delta: string,
): StreamRepetitionDetection | undefined {
  if (!state.enabled || state.triggered || !delta) return undefined;

  updateCodeFenceParity(state, delta);
  state.buffer += delta;
  if (state.buffer.length > STREAM_REPETITION_GUARD_WINDOW_CHARS) {
    const cut = state.buffer.length - STREAM_REPETITION_GUARD_WINDOW_CHARS;
    state.buffer = state.buffer.slice(cut);
    state.bufferStartIndex += cut;
  }
  state.charsSinceCheck += delta.length;
  if (state.charsSinceCheck < STREAM_REPETITION_GUARD_CHECK_INTERVAL_CHARS) return undefined;
  state.charsSinceCheck = 0;

  const detection = detectTailRepetition(
    state.buffer,
    state.fenceOpen
      ? STREAM_REPETITION_GUARD_CODE_FENCE_MIN_EVIDENCE_CHARS
      : STREAM_REPETITION_GUARD_MIN_EVIDENCE_CHARS,
  );
  if (!detection) return undefined;

  state.triggered = true;
  const bufferEnd = state.bufferStartIndex + state.buffer.length;
  return {
    ...detection,
    totalChars: bufferEnd,
    trimToIndex: state.bufferStartIndex + detection.trimToIndexInWindow,
  };
}

/** 增量维护 ``` 围栏奇偶；保留 2 字符尾接，跨 delta 拆分的标记不漏计不重计。 */
function updateCodeFenceParity(state: StreamRepetitionGuardState, delta: string): void {
  const window = state.fenceCarry + delta;
  let index = window.indexOf("```");
  while (index !== -1) {
    state.fenceOpen = !state.fenceOpen;
    index = window.indexOf("```", index + 3);
  }
  state.fenceCarry = window.slice(-2);
}

/**
 * 只把模型自身生成的 text delta 喂给护栏。工具调用入参（tool_input_delta）、
 * reasoning delta 均不参与检测，工具输出根本不经过模型流事件——后台任务的
 * 轮询等待（bash for 循环 + 定期 echo）全部落在这些通道里，不会进入检测器。
 */
export function feedTextDeltasIntoRepetitionGuard(
  state: StreamRepetitionGuardState,
  events: readonly ModelStreamEvent[],
): StreamRepetitionDetection | undefined {
  let detection: StreamRepetitionDetection | undefined;
  for (const event of events) {
    if (event.type !== "text_delta" || !event.text) continue;
    detection = feedStreamRepetitionGuard(state, event.text) ?? detection;
    if (detection) break;
  }
  return detection;
}

interface WindowDetection {
  trimToIndexInWindow: number;
  unitLength: number;
  repeatCount: number;
  unitContainsNewline: boolean;
}

function detectTailRepetition(
  buffer: string,
  minEvidenceChars: number,
): WindowDetection | undefined {
  const length = buffer.length;
  const maxUnitLength = Math.min(
    STREAM_REPETITION_GUARD_MAX_UNIT_CHARS,
    Math.floor(length / STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS),
  );
  for (
    let unitLength = STREAM_REPETITION_GUARD_MIN_UNIT_CHARS;
    unitLength <= maxUnitLength;
    unitLength += 1
  ) {
    // 先做 O(1) 探针再进入整段比较，避免正常输出下为每个候选长度分配子串。
    const last = length - 1;
    if (
      buffer.charCodeAt(last) !== buffer.charCodeAt(last - unitLength) ||
      buffer.charCodeAt(last - (unitLength >> 1)) !==
        buffer.charCodeAt(last - unitLength - (unitLength >> 1)) ||
      buffer.charCodeAt(last - unitLength + 1) !== buffer.charCodeAt(last - 2 * unitLength + 1)
    ) {
      continue;
    }
    const unit = buffer.slice(length - unitLength);
    const unitContainsNewline = unit.includes("\n");
    const minRepeats = unitContainsNewline
      ? STREAM_REPETITION_GUARD_BLOCK_MIN_REPEATS
      : STREAM_REPETITION_GUARD_WALL_MIN_REPEATS;
    let repeats = 1;
    let index = length - unitLength;
    while (index - unitLength >= 0 && buffer.slice(index - unitLength, index) === unit) {
      repeats += 1;
      index -= unitLength;
    }
    if (repeats < minRepeats) continue;
    // 证据量下限：份数达标但总长不足（短行引用 / 围栏内回显）仍不触发。
    if (repeats * unitLength < minEvidenceChars) continue;

    // 计数按「末尾对齐」进行，而真实重复区可能从相位中间开始（例如前缀长度不是
    // 单元长度的整数倍）。沿周期逐字符向前扩展到真正的重复起点，保证裁剪不残留
    // 半截墙、也不多保留一份块。
    const tailStart = extendPeriodicStartBackward(buffer, length - repeats * unitLength, unit);
    return {
      // 块级保留 1 份（首个副本是模型本意的收尾内容），墙级整段丢弃。
      trimToIndexInWindow: unitContainsNewline ? tailStart + unitLength : tailStart,
      unitLength,
      repeatCount: repeats,
      unitContainsNewline,
    };
  }
  return undefined;
}

/** [tailStart, tailStart + unit.length) 等于 unit；向前扩展周期覆盖到的最早起点。 */
function extendPeriodicStartBackward(buffer: string, tailStart: number, unit: string): number {
  const unitLength = unit.length;
  let start = tailStart;
  while (
    start > 0 &&
    buffer.charCodeAt(start - 1) ===
      unit.charCodeAt(((start - 1 - tailStart) % unitLength + unitLength) % unitLength)
  ) {
    start -= 1;
  }
  return start;
}
