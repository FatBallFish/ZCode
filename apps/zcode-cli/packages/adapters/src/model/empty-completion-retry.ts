import { ModelErrorCode, ModelFailureReason, ModelRetryReason } from "@zcode/contracts";
import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { calculateRetryDelay, logRetryDelayDecision, sleep } from "./runner-retry.js";
import { publishModelStatus, type ModelStatusContext } from "./runner-status.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

// 修复依据（2026-10-16 客户报障，specs/agent/empty-completion-retry.md）：网关（sub2api →
// ChatGPT Codex 通道）间歇性返回 response.failed 空响应，旧预算 1 次导致连续两连空
// 直接把 turn 判失败（4 天日志 13 次空回、5 组两连空）；提高预算可直接消掉大部分
// 用户可见空输出。语义：同一轮请求最多重试 5 次（连同首试最多 6 次物理尝试），
// 与网络错误重试（maxAttempts，默认 11）是独立预算、互不占用。
export const EMPTY_COMPLETION_MAX_RETRIES = 5;
export const EMPTY_COMPLETION_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

export function createEmptyCompletionFailure(): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.InvalidModelResponse,
    message: EMPTY_COMPLETION_MESSAGE,
    reason: ModelFailureReason.Unknown,
    retryReason: ModelRetryReason.ServerError,
    retryable: true,
  };
}

export function canRetryEmptyCompletion(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  maxAttempts: number;
  retryCount: number;
}): boolean {
  return (
    !input.abortSignal?.aborted &&
    input.retryCount < EMPTY_COMPLETION_MAX_RETRIES &&
    input.attempt < input.maxAttempts
  );
}

export async function scheduleEmptyCompletionRetry(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  completedAt: number;
  errorPhase: "response" | "stream";
  logger?: Logger;
  requestHeaders: Record<string, string>;
  requestStatusSink?: ModelStatusSink;
  responseHeaders: Record<string, string>;
  retry: ResolvedAiSdkModelRetryOptions;
  retryBudgetAttempt: number;
  startedAt: number;
  statusContext: ModelStatusContext;
  statusSink?: ModelStatusSink;
  streamOutputCommitted?: boolean;
}): Promise<void> {
  const failure = createEmptyCompletionFailure();
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      durationMs: input.completedAt - input.startedAt,
      errorCode: failure.code,
      errorPhase: input.errorPhase,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryable: true,
      ...(input.streamOutputCommitted !== undefined
        ? { streamOutputCommitted: input.streamOutputCommitted }
        : {}),
      timestamp: new Date(input.completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );

  const delayMs = calculateRetryDelay(input.retry, input.retryBudgetAttempt);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: true,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders: input.responseHeaders,
    statusContext: input.statusContext,
  });
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      delayMs,
      errorCode: failure.code,
      message: failure.message,
      nextAttempt: input.attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );
  await sleep(delayMs, input.abortSignal);
}
