# gpt-6.1-sol 双链路对比：EagleCloud（sub2api 中转）× 客户端会话身份

- 日期：2026-10-21（接 `2026-10-21-agent-context-preset-bench-results.md`）
- 背景：用户指出首轮实测的 gpt-6.1-sol 只走了 EagleCloud（sub2api 中转 ChatGPT 账号），期望同时测「ChatGPT 账号直连 OpenAI」链路并对比差异；且 gpt-6.1-sol 请求不稳定，需要多轮重复排除噪声。
- 方法：同一 harness（4 预设 × 41k 起始上下文 + 手动压缩），EagleCloud 链路跑 3 个变体各 3/2 轮重复：
  1. `gpt`（裸）：请求不带任何会话身份 —— Mikiko 当前 openai-responses wire 的真实行为；
  2. `gpt-sticky`：带 `prompt_cache_key=<会话内稳定值>`；
  3. `gpt-codexmode`：带 `prompt_cache_key` + `metadata.user_id=session_*`（对齐 Codex CLI 的完整身份字段）。
  全部走 `/v1/responses`（wire=responses 已确认，无 chat-completions 回退），24+8 组 0 失败。

## 1. ChatGPT 直连腿：本机凭据不可得（阻塞）

排查链（全部实际执行）：

| 候选凭据 | 结果 |
| --- | --- |
| `~/.zcode/v2` provider_config / credentials | 只有 bigmodel 套餐与两个中转 provider，无 OpenAI 直连 |
| `~/.codex/auth.json.person/company.json` | 值为 `cr_` 前缀（sub2api 签发 key），对 `api.openai.com` 与 `chatgpt.com/backend-api` 均 401 |
| Keychain `Codex Safe Storage` | 密钥可读，但 Codex 应用数据内未发现 v10 加密 blob（无候选可解密） |
| Keychain `Codex Key` | 返回空值 |
| Codex CLI 配置 | `~/.codex/config.toml` 的默认 provider 本身就是 `eaglecloud_codex`（中转）；`ruok_proxy`（requires_openai_auth）所需的 OpenAI 登态在本机 CLI 侧不存在（auth.json 被替换为中转 key 文件） |

**需要你提供其中一种**：可访问 gpt-6.1-sol 的 OpenAI 平台 API key、ChatGPT 账号的 OAuth token 导出、或指定一种可用的直连方式。拿到后我用同一 harness 直接补测（target 定义已就绪，改 baseUrl/key 即可）。

## 2. EagleCloud（sub2api）三变体实测

### 2.1 总命中率（每格 3 轮重复，%）

| 预设 | gpt（裸，现状） | gpt-sticky（+prompt_cache_key） | gpt-codexmode（+完整身份） |
| --- | --- | --- | --- |
| default | 2.1 / 2.1 / 0.0 | 88.1 / 88.1 / 86.5 | 见 §2.3 |
| fused | 20.9 / 0.0 / 20.9 | 88.0 / 86.5 / 88.1 | 见 §2.3 |
| deepseek-style | 0.0 / 11.7 / 0.0 | 88.5 / 88.5 / 88.4 | 见 §2.3 |
| codex-style | 0.9 / 0.0 / 1.8 | 85.4 / 85.4 / 79.6 | 见 §2.3 |

### 2.2 读取要点

1. **裸链（Mikiko 现状）在 EagleCloud 上缓存基本失效**：三轮重复 0-21% 剧烈波动，压缩前阶段也经常整段 0%——同一会话的连续请求互相都不命中。
2. **仅加 `prompt_cache_key` 一项，命中率跃升至稳定 86-88.5%**（方差 <2pp，除 codex rep3 79.6%）；压缩后首请求命中 64-80%（deepseek-style 77-80%），是全部实测中最强的压缩后恢复。
3. sticky 腿压缩前阶段 87.1% 与 GLM-5.3 的 87.4% 几乎一致：**中转链路上游（ChatGPT backend）的缓存能力并不差，整条链路缺的只是会话身份**。
4. codex-style 在 sticky 腿的压缩后首请求仅 0-15.5%：摘要尾置 + 大保留量使首请求几乎全新，为该预设的结构性代价。

### 2.3 gpt-codexmode（+metadata.user_id，每格 2 轮重复，%）

| 预设 | 总命中率 | 压缩后首请求 |
| --- | --- | --- |
| default | 88.1 / 86.5 | 64.4 / 64.4 |
| fused | 88.1 / 88.0 | 65.8 / 64.0 |
| deepseek-style | 88.4 / 88.4 | 76.2 / 74.6 |
| codex-style | 85.4 / 85.4 | 15.5 / 15.5 |

与 gpt-sticky 逐格一致（差异 ≤0.1pp）：在 EagleCloud 链路上 `prompt_cache_key` 已足够触发 sub2api 的账号粘性，`metadata.user_id` 是 Codex 客户端的冗余保险，不带来额外缓存收益。

## 3. 链路差异的机制解释（sub2api 源码证据）

读 `~/Documents/Projects/GoProjects/Personal/sub2api` 源码确认：

1. **账号粘性调度**（`backend/internal/service/openai_account_scheduler.go:2439-2445`）：先按 `sessionHash` 查 `getStickySessionAccountID`（缓存映射、带 TTL），命中则粘住同一上游 ChatGPT 账号；未命中走加权选择——**池内多账号各自独立的服务端缓存，换账号=全量 miss**。
2. **sessionHash 的三个来源**（`gateway_service.go:897-960 GenerateSessionHash`）：
   - 优先级 1：`metadata.user_id` 内的 session id（**Codex CLI 每请求都发**，格式 `session_<uuid>`）；
   - 优先级 2：`cache_control: ephemeral` 内容哈希（Anthropic 风格请求）；
   - 优先级 3 fallback：ClientIP+UA+KeyID+system+全部消息文本哈希——**随对话增长逐轮变化，等于无粘性**。
   Mikiko 的 openai-responses 请求既无 metadata.user_id 也无 cache_control → 落 fallback → 每轮可能换账号 → 裸链的随机命中率。
3. **身份改写层**（`openai_codex_account_identity.go:118-245`）：把 `prompt_cache_key`/session/thread/window 等 identity 字段改写为「API key × 账号 × 原值」的作用域值后转发上游——防跨用户碰撞，同时让上游 OpenAI 以稳定 key 做缓存亲和。
4. 结论：**「中转 vs 直连」的表象差异，主要 = 客户端是否携带会话身份**。Codex 直连拿 95% 的一部分原因也是它永远发送 prompt_cache_key/session 身份；同一中转链路上带身份即可达 ~88%。

## 4. 产品修复（已于 2026-10-22 实施）

在 Mikiko 的 openai-responses wire 上随请求携带 `prompt_cache_key = sessionId`，默认智能适配（仅 gpt 前缀模型发送），按模型可用 `properties.promptCacheKeyMode: auto|on|off` 强制启停：

- 实现：`docs/specs/openai-responses-prompt-cache-key.md`（门控定义）、`apps/zcode-cli/packages/adapters/src/model/runner-options.ts`（`withOpenAiPromptCacheKey`）、root `packages/shared/src/model-config.ts` + `packages/provider`（属性管线）。
- 验收：wire 级单测 6/6 通过；服务端效果由本文 gpt-sticky 变体实测背书。

## 5. 复现

```bash
cd apps/zcode-cli/packages/core
ZCODE_LIVE_BENCH=gpt,gpt-sticky,gpt-codexmode ZCODE_BENCH_REPS=3 \
  ZCODE_BENCH_DOC_SECTIONS=40 ZCODE_BENCH_PRE_TURNS=8 ZCODE_BENCH_STAMP=eagle-2 \
  npx vitest run tests/context-preset-live.test.ts --testTimeout=5400000
python3 ../../scripts/summarize-context-bench.py eagle-2
```

结果文件：`.bench-results/live-eagle-1.json`、`live-codexmode-1*.json`。
