# Provider 级全局上下文窗口 / 最大输出 Token 覆盖（2026-10-15）

## 背景与目标

自定义供应商、Sub2api、MikikoCC 三类供应商（统一落成 personal provider）的模型
分组内常有大量模型，逐个配置「上下文窗口 / 最大输出 Token」繁琐且易漏。新增
**Provider（分组）级**两个可选配置，实现一次配置覆盖全组模型：

- `api.contextWindow`：全局上下文窗口（token 数）
- `api.maxOutputTokens`：全局最大输出 Token

## 字段语义（三态，与既有 overlay 纪律一致）

| 状态                 | 存储值     | 行为                                   |
| -------------------- | ---------- | -------------------------------------- |
| 未配置（缺省）       | `undefined` | 不覆盖，模型自身配置生效               |
| 已配置               | 正整数     | 覆盖分组内**所有模型**的同类值         |
| 置空（清除）         | `null`     | 恢复模型自身配置                       |

- 位置：Provider `config.api` 上，与 `type`（API 格式）同级。
- 校验：`z.number().int().positive().nullable().optional()`，sparse 与 complete
  schema 同形（`provider-data-schema.ts`）。
- 可配范围：仅 API 格式为 `anthropic-messages`（Message）/`openai-chat-completions`
  （Chat）/`openai-responses`（Response）三协议时可编辑；当前 personal provider 的
  协议全集即此三者，UI 守卫面向未来新增协议类型。

## 生效链路（单一覆盖点）

```
UI ProviderConnectionSection（API 格式同级输入）
  → ProviderDraftSave 稀疏 overlay（只写改动叶子）→ provider_config.json
  → ProviderConfigResolver.resolve per-model loop（唯一覆盖点）
      api.contextWindow 非空   → modelConfig.properties.contextWindow
      api.maxOutputTokens 非空 → modelConfig.optionSpecs.maxOutputTokens.max
  → Registry（serializeRegistryModelConfig）→ 运行时 modelFactory
      → 会话请求：turn-model-step 上下文窗口判断 / maxOutputTokens 收敛
      → autoCompact（compact.ts）与 compact 摘要上限（compact-active cap）自动跟随
      → 模型选择器投影 / facades 继承展示自动跟随
```

- 覆盖仅作用于 `max`，不动 effort `map`（运行时对 map 有 min 收敛兜底）。
- relay（Sub2api/MikikoCC）激活投影 `savePersonalProviderOverlay` 时**保留**用户
  已配置的这两个字段，不得被整份 api 覆盖清掉。

## UI 行为

- 设置 · 模型设置 · 供应商编辑（ProviderConnectionSection）：API 格式下方两个可选
  数字输入，占位符提示「配置后覆盖分组内所有模型」；清空输入即写 `null` 置空。
- 模型元数据弹窗（ProviderModelMetadataFields）：分组覆盖存在时，模型自身的
  「上下文窗口 / 最大输出 Token」输入置灰并显示「已被分组配置覆盖」徽标；
  置空分组配置后自动恢复可编辑。

## 语义整理（最大输出 Token 取值）

- 会话上下文整理（compact 摘要）：随覆盖自动生效（`capCompactSummaryMaxOutputTokens`
  取 min(模型 max, 20K)，模型 max 即覆盖后值）。
- 语音输入「语义整理」（useVoiceInputController）：原硬编码 16384；改为语音所选
  模型对应 Provider 的分组 `maxOutputTokens` 覆盖存在时用覆盖值，否则维持 16384
  （未配置不改变既有调参行为）。

## 验收场景

1. 分组配置 contextWindow=500000 / maxOutputTokens=100000 → 分组内所有模型的
   请求上下文判断与 maxOutputTokens 取 500000/100000（registry 视图与 UI 继承展示一致）。
2. 置空分组配置（null）→ 模型自身配置恢复生效。
3. 未配置 → 行为与改动前完全一致（默认路径零影响）。
4. 模型元数据弹窗在覆盖存在时置灰对应输入；置空后恢复。
5. relay 站点重新激活密钥投影后，已配置的分组覆盖不丢失。
6. autoCompact 触发与 compact 摘要输出上限跟随覆盖值。
