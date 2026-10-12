import type { ChatGPTRequestOutcome } from "@zcode/shared";

/**
 * ChatGPT 请求结果上报端口（进程级）。
 *
 * 上报是 fire-and-forget：transport 收到 401/402/403/429 或限流头时尽力投递，
 * 失败不影响请求本身。CLI 每个进程服务一个 workspace，bootstrap 在协议服务端
 * 建立时注册 reporter（经 interaction/reportChatGPTRequestOutcome 发给 host），
 * adapters 层不感知协议细节。
 */

export type ChatGPTRequestOutcomeReporter = (outcome: ChatGPTRequestOutcome) => void;

let reporter: ChatGPTRequestOutcomeReporter | undefined;

export function setChatGPTRequestOutcomeReporter(next: ChatGPTRequestOutcomeReporter | undefined): void {
  reporter = next;
}

export function reportChatGPTRequestOutcome(outcome: ChatGPTRequestOutcome): void {
  try {
    reporter?.(outcome);
  } catch {
    /* 上报失败静默：不能影响模型请求主链路 */
  }
}

/** 用量被动上报节流：同 provider 30s 内只投递一次（官方 rate_limits 口径）。 */
const USAGE_REPORT_THROTTLE_MS = 30_000;
const lastUsageReportAt = new Map<string, number>();

export function shouldReportChatGPTUsage(providerId: string, now = Date.now()): boolean {
  const last = lastUsageReportAt.get(providerId) ?? 0;
  if (now - last < USAGE_REPORT_THROTTLE_MS) return false;
  lastUsageReportAt.set(providerId, now);
  return true;
}
