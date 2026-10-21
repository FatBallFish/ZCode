# openai-responses wire 的 prompt_cache_key（会话缓存亲和）

状态：已实现（2026-10-22）；背景与实测依据见 `docs/analysis/2026-10-21-gpt-dual-link-bench.md` §4。

## 1. Feature Summary / Impact Brief

| Field | Value |
| --- | --- |
| Developer intent | openai-responses wire 请求携带 `prompt_cache_key = sessionId`，让中转（sub2api 等按会话粘性路由账号池）与 OpenAI 官方（缓存亲和）命中会话级前缀缓存；实测该字段缺失时 EagleCloud 链路命中率 0-21% 随机，携带后稳定 86-88.5% |
| Capability | adapters 模型请求组装、模型属性 schema（promptCacheKeyMode） |
| 所有权 | 门控逻辑唯一所有者是 `apps/zcode-cli/packages/adapters/src/model/runner-options.ts` 的 `withOpenAiPromptCacheKey`；属性解析沿用 provider 包 overlay 管线 |
| Wire 影响面 | 仅 `providerKind === "openai"`（openai-responses wire）请求体新增可选字段 `prompt_cache_key`；anthropic / openai-compatible（chat）wire 不变 |

## 2. 行为定义

注入点：`createGenerateTextOptions` / `createStreamTextOptions`（与 `mergeAnthropicRequestMetadata` 同层），对 AI SDK 调用级 `providerOptions.openai.promptCacheKey` 赋值（AI SDK v6 `@ai-sdk/openai` 原生映射到 wire 字段 `prompt_cache_key`）。

值：`statusContext.sessionId`（会话级稳定，与 Codex 以 session 派生 key 同语义；sidecar 请求同会话共享亲和）。

门控（短路顺序）：

1. `providerKind !== "openai"` → 不发送；
2. `sessionId` 缺失 → 不发送；
3. `promptCacheKeyMode === "off"` → 不发送；
4. `promptCacheKeyMode === "auto"`（缺省）且模型名不以 `gpt` 开头（大小写不敏感）→ 不发送；
5. 请求已显式提供 `providerOptions.openai.promptCacheKey` → 尊重请求值，不覆盖。

按模型强制启停：provider/model 配置的 `properties.promptCacheKeyMode: "auto" | "on" | "off"`（optional，缺省 auto），经 `ModelPropertiesConfig` overlay 与 `serializeRegistryModelConfig` 传递（root `packages/provider`），schema 定义在 root `packages/shared/src/model-config.ts`。

## 3. 事件顺序与边界

```text
provider_config.json（模板/模型规则，可含 promptCacheKeyMode）
  → provider overlay（ModelPropertiesConfig）→ resolver 序列化 → RegistryModelConfig.properties
  → adapters resolveSnapshot → resolved.properties
  → 每次 generate/stream 请求组装（runner-options）按门控注入 providerOptions.openai.promptCacheKey
  → AI SDK 序列化为 wire 字段 prompt_cache_key
```

- 注入发生在每个 attempt 的 options 组装处；重试/刷新 headers 不影响该字段（会话身份不变）。
- chatgpt-account（ChatGPT 账号直连）同样走 openai responses 模型：auto 模式下 gpt 前缀即发送，与 Codex 客户端行为一致。
- 不发送额外 header、不改变消息体与断点逻辑；对不识别该字段的兼容端点按 OpenAI 兼容惯例应忽略未知字段（如遇报错按模型将 promptCacheKeyMode 置 off）。

## 4. 验收

- wire 级单测：`apps/zcode-cli/packages/adapters/tests/openai-prompt-cache-key-wire.test.ts`（6 用例：auto×gpt 发送、auto×非 gpt 不发送、on 强制、off 禁用、显式请求值优先、大小写不敏感前缀）。
- schema/overlay 单测：`packages/shared/test/modelConfigContract.test.ts`、`packages/provider/test/model-config-rules.test.ts`（枚举校验 + overlay 传递，next 优先）。
- 服务端效果由 `docs/analysis/2026-10-21-gpt-dual-link-bench.md` 的 gpt-sticky 变体实测背书（同字段手工注入 24 组，命中率 0-21% → 86-88.5%）。
