# 会话统计（Session Stats）

> 2026-10-19 需求：会话页输入框上下文组件旁新增统计胶囊与弹出卡片。
> 参考形态：胶囊「3 轮 24 步 · 73 tok/s」；点开卡片「会话统计」四行指标。

## 指标口径

| 指标 | 口径 | 来源 |
| --- | --- | --- |
| 轮次 turnCount | `TurnStarted` 事件计数（每轮用户输入一次） | 投影累计 |
| 步数 stepCount | main_turn `ModelComplete` 计数（每次模型请求 = 一步） | 投影累计 |
| 模型用时 modelDurationMs | Σ main_turn 请求 `durationMs`（来自 `model_request_completed`，`ModelComplete` 消费时读取并清空暂存，避免双计） | 投影累计 |
| 工具调用用时 toolDurationMs | Σ toolCall 行 `endedAt − startedAt`（行进入终态时累计一次） | 投影累计 |
| 首 token 平均 ttftAvgMs | main_turn `timeToFirstContentMs ?? timeToFirstTextMs` 的算术平均；无样本为 null | 投影累计 |
| 输出速度（卡片，会话平均） | Σ outputTokens ÷ Σ generationDurationMs × 1000；generationDuration = max(0, durationMs − ttftMs) | 投影累计 |
| 实时输出速度（胶囊，tok/s） | 流式期间最近 5s 滚动窗口内 text_delta 估算 token ÷ 5；估算 = CJK 字符 ×1 + 其他字符 ÷4；请求完成（ModelComplete）即置 null，UI 回退显示最近一次请求 TPS（会话平均） | 投影累计 |

## 所有权与链路（单一所有者：CLI 投影）

```
SessionEvent(TurnStarted/ModelStreaming.text_delta/model_request_completed/ModelComplete/工具行终态)
  → bootstrap ProductProjection 聚合（sessionStatsState，仅内存，不落盘）
  → v4 snapshot.stats（additive optional）+ state.updated patch { stats }（A 区字段级整体替换）
  → RPC ConversationTopicFrame → SessionPane → ConversationComposer → V4ComposerToolbar
  → ChatSessionStats 胶囊（ChatContextUsage 旁）+ Popover 卡片
```

- 降级发射节流：text_delta 高频，liveTokensPerSecond 仅在值变化 ≥1 tok/s 或其他
  统计变化时随 patch 下发，避免帧量翻倍。
- 旧 CLI / 旧快照无 stats 字段（optional）→ UI 胶囊整体隐藏，不影响既有布局。
- 指标均为会话内累计，新会话自然归零；投影状态随事件重放重建（冷恢复同样成立）。

## UI

- 组件 `packages/ui/src/chat-input-toolbar/ChatSessionStats.tsx`；挂载
  `V4ComposerToolbar` 的 context usage 簇（`ChatContextUsage` 旁）。
- 胶囊：`{turnCount} 轮 {stepCount} 步 · {live ?? avg} tok/s`（流式中显示 live，
  空闲显示会话平均；平均无样本时只显示轮次/步数）。
- 卡片（Popover，复用 Context 面板形态）：模型用时 / 工具调用用时 / 首 token 平均（TTFT）/
  输出速度（TPS）；时长格式化复用既有时长格式器；i18n zh/en。
