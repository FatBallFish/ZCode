# Agent 上下文预设实测报告（缓存命中率 × 压缩效果）

- 日期：2026-10-21
- 关联：`docs/specs/agent-context-preset.md`（实现）、`docs/plans/2026-10-21-session-cache-compaction-strategy-comparison.md`（方案设计）
- 方法：`apps/zcode-cli/packages/core/tests/context-preset-live.test.ts`（`ZCODE_LIVE_BENCH` 门控），4 预设 × 3 模型 × 单次长上下文会话（40 节合成手册 ≈ 41k token 起始上下文 + 8 轮问答 + 1 次手动压缩 + 3 轮回忆探针）；请求构造完全复用 core 真实的 `buildProviderRequestMessages`（断点布局）、`selectCompactEntries`（保留策略）、`buildCompactPrompt`/`buildCompactSummaryMessage`（模板）、`buildPostCompactRuntimeEntries`（压缩后结构）。
- 模型（用户本机 Mikiko 已配置的 provider）：GLM-5.3（bigmodel 套餐，anthropic wire）、deepseek-v4.1-flash-1017（api.mikiko.cc，anthropic wire）、gpt-6.1-sol（EagleCloud 内网代理 10.30.202.6:8080，openai wire）。
- 命中率口径：cacheRead / 计费 prompt 总量（按各端点 usage 口径自适应分母），与产品口径 `sum(cacheRead)/sum(inputTokens)` 一致。
- codex-style 首轮实测发现单条超大用户消息会吃掉整个保留预算（压缩率 −1.4%），已按 Codex 原版语义补上单条截断（含单测），表中 codex-style 为修复后重测值。

## 1. 总表（12 组，0 失败；codex-style 为修复后数值）

| 模型 | 预设 | 总命中率 | 压缩前阶段 | 压缩后首请求 | 压缩后聚合 | 压缩率 | 保留 entries | 摘要输出 token | 回忆探针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GLM-5.3 | default | **88.0%** | 87.4% | 0.0% | 64.8% | 94.0% | 0 | 2949 | 3/3 |
| GLM-5.3 | fused | **87.9%** | 87.4% | 0.0% | 64.4% | 93.4% | 13 | 3350 | 3/3 |
| GLM-5.3 | deepseek-style | **88.3%** | 87.4% | 0.0% | 64.3% | 95.9% | 13 | 1987 | 3/3 |
| GLM-5.3 | codex-style | 75.8% | 87.4% | 0.0% | 66.6% | 38.8% | 9 | 2057 | 3/3 |
| deepseek-v4.1-flash-1017 | default | **98.8%** | 99.2% | 66.4% | 64.2% | 95.5% | 0 | 1399 | 3/3 |
| deepseek-v4.1-flash-1017 | fused | 87.9% | 87.2% | 0.0% | 58.2% | 92.9% | 13 | 2553 | 3/3 |
| deepseek-v4.1-flash-1017 | deepseek-style | **98.7%** | 99.4% | 0.0% | 45.8% | 96.4% | 13 | 895 | 3/3 |
| deepseek-v4.1-flash-1017 | codex-style | 93.7% | 87.2% | 0.0% | 66.4% | 38.6% | 9 | 1476 | 3/3 |
| gpt-6.1-sol（EagleCloud 代理） | default | 0.0% | 0.0% | 0.0% | 0.0% | 92.8% | 0 | 2175 | 3/3 |
| gpt-6.1-sol（EagleCloud 代理） | fused | 12.1% | 12.5% | 0.0% | 32.4% | 93.4% | 13 | 1648 | 3/3 |
| gpt-6.1-sol（EagleCloud 代理） | deepseek-style | 22.3% | 24.9% | 81.3% | 26.8% | 96.8% | 13 | 377 | 3/3 |
| gpt-6.1-sol（EagleCloud 代理） | codex-style | 9.1% | 12.4% | 0.0% | 0.0% | 39.3% | 9 | 679 | 3/3 |

## 2. 关键发现

### 2.1 「85% vs 95%」的大头是 provider 侧缓存基础设施，不是客户端编排

同一份客户端代码、同一份对话与断点策略：

- **DeepSeek 兼容端点：98.8%**。稳态轮 usage 只计增量（input 46–166 token，其余全部 cacheRead≈41k），磁盘缓存按块命中、跨请求粒度极细。
- **GLM 端点：87.4–88.3%**（四预设无差异），与客户反馈的 ~85% 同区间。
- **EagleCloud（gpt-6.1-sol）内网代理：0–22% 且大幅波动**（同一预设先后两轮 0.0%/81.3%），是代理后端路由/缓存不稳定，不能用于 A/B 归因。

结论：Codex/DSH 的 95% 有相当部分来自「自家模型 + 自家缓存基础设施」（DeepSeek 增量计费式磁盘缓存、OpenAI 会话亲和 + 增量续传）。Mikiko 在 GLM 上能通过客户端手段回收的空间约在个位数百分比；结构性差距需 provider 侧能力（GLM 端点若支持分块部分命中或会话亲和，收益会远超客户端优化）。

### 2.2 压缩后首请求在所有 provider × 所有预设下都是全量 miss

除两处方差噪声外，postFirst 全部为 0%：压缩重建历史后，新前缀与任何已缓存前缀不匹配。唯一的非零（deepseek/default 66.4%）经逐请求核对只是命中了 1024 token（一个缓存块）。第二、三轮即恢复（post 聚合 58–67%）。

含义：**压缩的缓存代价不可避免，可优化的是「发生频率」与「单次重建量」**——这正是预设里阈值前移（fused 85% / deepseek 80% / codex 90% 替代现状的 ~100%）+ 防连环压缩（保留预算受阈值约束）的价值所在；本次 bench 全部为手动压缩，自动压缩频率收益需长会话实测补充。

### 2.3 预设的可测差异集中在压缩效果，而非 provider 命中率

- **default**：压缩率 94–95.5%，保留 0 条，摘要 1.4k–2.9k token（最激进、信息全押摘要）。
- **fused**：压缩率 92.9–93.4%，保留 13 条近期原文 + todo 重注入 + transcript 路径（近期上下文零损耗）。
- **deepseek-style**：压缩率最高 95.9–96.8%，摘要最瘦（377–1987 token）——pruner（免模型裁剪大工具结果）+ 8 段 checkpoint 模板效果直接可见。
- **codex-style**：压缩率 38.6–39.3%——按设计保留用户原话（20k 预算），在「单条大文档粘贴」场景压缩比天然低（修复后保留截断头 + 摘要）。它的定位是「用户意图零损耗」，不是「最小上下文」。

### 2.4 断点布局（anchored）在三个 anthropic 兼容端点上无可测缓存收益

GLM 四预设命中率差异 <0.5pp；DeepSeek 端点的 run 间方差（同布局两轮 99.4% vs 87.2%，冷启动请求 read=0/40k 各半）大于任何布局效应；EagleCloud 不可归因。anchored 布局的理论收益场景是官方 Anthropic 端点（显式 4 断点语义），本机未配置 Claude 系 provider，未覆盖——此结论只对本次三个端点成立。

### 2.5 回忆探针 36/36 全对

合成手册的端口事实在四个预设、三个模型上全部正确回忆（含 default 全摘要路径）。说明：四套摘要模板在「事实保全」上都过关；客户反馈的「失忆」更可能来自工具态/项目探索状态丢失（Read/Grep 结果、todo、计划），这正是 fused 预设 todo/文件清单/plan/transcript 四重恢复所针对的结构性缺口——本 harness 无工具，无法直接度量该维度，是已知局限。

## 3. 局限

1. 每格 n=1，DeepSeek/EagleCloud 端点存在后端路由方差；跨预设的命中率小差异不可归因（压缩率/保留数/摘要体积是确定性的，可归因）。
2. 手册为合成文本、会话无工具调用；未覆盖自动压缩触发、MCP 工具集中途变化、多轮连环压缩。
3. EagleCloud 为内网代理，其数字反映代理而非 OpenAI 官方缓存。
4. 回忆探针过易（端口数字），区分度不足；失忆维度的工具态恢复需端到端（桌面 E2E）验证。

## 4. 复现

```bash
cd apps/zcode-cli/packages/core
# 全量 12 组（读取 ~/.zcode/v2/provider_config.json，勿提交密钥）
ZCODE_LIVE_BENCH=glm,deepseek,gpt ZCODE_BENCH_DOC_SECTIONS=40 ZCODE_BENCH_PRE_TURNS=8 \
  ZCODE_BENCH_STAMP=<tag> npx vitest run tests/context-preset-live.test.ts --testTimeout=3600000
# 汇总
python3 ../../scripts/summarize-context-bench.py <tag>
```

结果文件：`apps/zcode-cli/.bench-results/live-full-1.json`、`live-codex-fix-1*.json`。
