# Agent 上下文预设（agentContextPreset）

状态：已实现（2026-10-21）；实测与结论见 `docs/plans/2026-10-21-session-cache-compaction-strategy-comparison.md` 与其引用的 bench 结果。
关联：`docs/context-cache-hit-rate.md`（命中率口径）、`docs/plans/2026-10-21-session-cache-compaction-strategy-comparison.md`（三方对比与四套方案设计）。

## 1. Feature Summary / Impact Brief

| Field | Value |
| --- | --- |
| Developer intent | 把「cache_control 断点布局 + 会话压缩算法」的差异收敛为一个用户可选预设，解决主会话缓存命中率偏低与压缩后失忆两类问题 |
| Capability | 系统设置、zcode protocol runtime preferences、CLI 压缩执行链、provider 请求投影 |
| Change layer | `contract`（shared schema）、`domain`（core compact preset）、`app`（bootstrap 接线）、`ui`（设置页） |
| 所有权 | 预设语义唯一所有者是 `apps/zcode-cli/packages/core/src/compact/preset.ts`；其他模块只消费 `resolveContextPreset()` 的解析结果 |
| Out of scope | 提示词文本内容的编排反转（AGENTS.md 追加声明式更新 / 极简 system）——方案 C/D 的编排部分列为后续工作 |

## 2. 预设语义（唯一事实来源）

`AgentContextPreset = "default" | "fused" | "deepseek-style" | "codex-style"`：

| 维度 | default | fused | deepseek-style | codex-style |
| --- | --- | --- | --- | --- |
| 自动压缩阈值 | 有效窗口 − 13k buffer（现状） | 0.85×窗口 | min(0.8×窗口, 有效窗口−64k) | 0.9×窗口 |
| 尾部原文保留 | Auto 1 轮组 / Manual 0 组 | token 预算 16% 窗口 | token 预算 16% 窗口 | 真实用户消息倒序累计 20k |
| 摘要模板 | 9 段 detailed（现状） | detailed + 文件清单/环境事实/todo/合并规则 | 8 段 checkpoint（对齐 DSH） | 短 handoff（对齐 Codex） |
| 摘要导语 | continuation（现状） | continuation | continuation | handoff（Codex SUMMARY_PREFIX） |
| 摘要位置 | 前缀后（现状） | 前缀后 | 前缀后 | 尾部（保留原文之后） |
| Read 恢复上限 | 5 文件×5k/总 50k | 10×8k/总 80k | 10×8k/总 80k | 5×5k/总 50k |
| transcript 回读 | 未接线（现状） | 摘要消息携带会话文件路径 | 无 | 无 |
| 大工具结果裁剪 | 无 | 无 | 进入摘要前 8192→4096+1024 裁剪 | 无 |
| 压缩后 todo 注入 | 否 | 是 | 是 | 否 |
| cache_control 布局 | 双 system 断点 + 最新消息 | 锚定：最后 system + 会话附件 + 摘要锚 + 最新（≤4 断点） | 同 fused | 同 fused |
| 防连环压缩 | 仅记录 willRetrigger | 保留预算受阈值约束（prefix+摘要预留+2k 余量） | 同 fused | 同 fused |

不变量：

1. `resolveContextPreset(undefined) === default` 且 default 的所有行为与历史版本逐字节一致（回归由 `tests/compact-*.test.ts` 与 `tests/context-preset.test.ts` 锁定）。
2. 预设是冷会话配置：新建/冷恢复 Session 读取；已有 Runtime 不变（与 `toolSearchMode` 同语义）。
3. anchored 断点布局的断点总数 ≤ 4（Anthropic cache_control 上限）；同一消息只打一个断点。
4. 压缩摘要请求永远 `skipCacheWrite`（断点前移到 compact prompt 之前的真实上下文），该行为对所有预设一致。

## 3. 状态与事件顺序

```text
AppSettings.agentContextPreset（用户数据目录 JSON，settingService 原子写）
  → Host 解析 runtime preferences（session/request-runtime-preferences，仅冷会话）
  → AgentRuntimeConfig.contextPreset（bootstrap 透传；无 Host 时 ZCODE_AGENT_CONTEXT_PRESET 环境变量回退）
  → compactActiveConversation 读取 resolveContextPreset() 一次，驱动：
      selectCompactEntries(保留策略) / buildCompactPrompt(模板) / buildCompactSummaryMessage(导语+transcript)
      buildPostCompactReadStateReminderEntries(上限) / buildPostCompactRuntimeEntries(摘要位置)
  → buildProviderRequestMessages(cacheLayout) 在每个 provider 请求边界应用断点布局
```

压缩事件顺序（所有预设共用，差异仅在各步骤参数）：阈值检查 → 区间选择 → 摘要请求（前缀重放 + skipCacheWrite）→ 摘要落盘 → `replaceMessages(prefix + 摘要 + 保留区 + reminders)` → 下一请求按布局打断点。

## 4. 验收

- 单测：`apps/zcode-cli/packages/core/tests/context-preset.test.ts`（阈值/保留/模板/导语/摘要位置/裁剪/断点布局/防连环预算）；shared 侧 schema 测试由设置链路改动补充。
- 真实模型实测：`apps/zcode-cli/packages/core/tests/context-preset-live.test.ts`（`ZCODE_LIVE_BENCH` 门控；4 预设 × GLM-5.3 / deepseek-v4.1-flash / gpt-6.1-sol，含手动压缩与压缩后回忆探针；结果落 `.bench-results/`）。
- default 预设回归：既有 compact 系列测试全量通过，未改任何 default 行为。

## 5. 已知边界

- gpt/deepseek 侧缓存为服务端自动前缀缓存，断点标记不改变其命中行为；anchored 布局对它们的收益主要来自压缩后的消息结构。
- `transcriptReference` 依赖模型有文件读取工具才能兑现回读；无工具场景仅作为路径线索。
- 方案 C/D 的「提示词编排反转」（AGENTS.md 变化改为尾部追加声明）未在本期实现，见对比文档第 6 节风险项。
