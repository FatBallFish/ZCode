# 模型空回重试（empty completion retry）

## 现象与修复依据

客户（Windows，v1.1.2，sub2api → ChatGPT Codex 通道）反馈"经常遇到请求输出为空"。
日志分析结论（2026-10-16 报障）：模型网关间歇性返回 `response.failed` 空响应——
HTTP 200、SSE 包络完整（start/start-step/finish-step/finish）、有 responseId，但
零文本、零工具调用、零 usage、零 error 事件。4 天日志共 13 次空回，其中 3 次靠
重试挽回、5 次因连续两连空（旧预算仅 1 次重试）直接把 turn 判失败。

## 触发条件（空回判定）

一轮 completion 同时满足：零文本 + 零工具调用（任何 finishReason 下均算可疑；
判定口径见 `runner-diagnostics.ts isSuspiciousModelCompletion` 与 core 侧
`model-errors.ts isSuspiciousEmptyModelResult`，2026-10-12 同步对齐——任何
finish 下的零文本+零工具都触发空回重试）。

## 预算（2026-10-16 起）

- `apps/zcode-cli/packages/adapters/src/model/empty-completion-retry.ts`
  `EMPTY_COMPLETION_MAX_RETRIES = 5`：同一轮模型请求遇到空回最多重试 5 次
  （连同首试最多 6 次物理尝试）。此前为 1（两连空即失败）。
- 判定函数 `canRetryEmptyCompletion` 同时受 `abortSignal` 未中止与
  `attempt < maxAttempts` 约束；预算由
  `retryCount < EMPTY_COMPLETION_MAX_RETRIES` 控制。
- runner-generate.ts 与 runner-stream.ts 各自维护 `emptyCompletionRetryCount`
  局部计数，共同消费该常量。

## 与网络错误重试的关系

- 空回重试与网络/服务端错误重试（`maxAttempts`，默认 11 = 首试 + 10 次）是
  **两套独立预算，互不占用**；但每次物理请求（含空回重试）都会使 `attempt` +1，
  因此 5 次空回重试 + 首试 = 6 次 < 默认 11，不会被总预算提前截断（若用户经
  `ZCODE_MODEL_RETRY_MAX_RETRIES` 调小总预算，则先触及 `maxAttempts` 上限）。
- 退避延迟复用 `calculateRetryDelay`（base 2s、倍增 2、单次上限 60s）：
  5 次重试的延迟序列为 2/4/8/16/32s，累计约 62s，可接受。
- 空回重试**不适用于** compact 流（`preserveProviderStreamBoundaries` 场景，
  见 runner.test.ts `does not add generic empty completion retry to compact streams`）。

## 验收场景

1. generateText/stream 首试空回、重试恢复 → 返回恢复后的结果，流场景不泄露
   空回尝试的事件。
2. 连续 6 次空回（首试 + 5 次重试）→ 停止重试，按现状走空回完成/失败路径。
3. 前 5 次均空回、第 6 次（最后一次预算内）恢复 → 返回恢复结果，证明预算 5 生效。
4. 网络错误重试计数不因空回重试而额外扣减（两预算独立）。
