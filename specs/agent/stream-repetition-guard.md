# 流式重复退化护栏（stream repetition guard）

## 现象与修复依据

客户会话（sess_6db0845f，2026-10-17，GLM-5.3，260k token 上下文）在收尾纯文本
阶段发生自回归退化：同一条 assistant 消息内「## 完成 ✅」总结块重复 9 次
（约 16.9k 字符），末段退化为 `— — —` 破折号墙。两波循环：

1. 第一波（98s，model-io 第 61 行）：8,622 output tokens，仅因模型碰巧吐出一个
   git status 工具调用而中断（`finishReason: "tool-calls"`），16.9k 重复文本被
   持久化进会话历史；
2. 第二波（252s，第 62 行）：git status 结果返回后继续生成并再次陷入循环，
   流式输出持续 252 秒无任何护栏干预，最终由用户手动 Stop
   （`AgentRuntime.stopActiveForegroundExecution`）中断。

请求参数 `max_tokens: 128000`、无 temperature/top_p/penalty（服务端默认），
模型侧不会自行收敛。既有护栏均不覆盖此形态：

- `stream-idle-timeout` 只在「无事件到达」时触发，重复循环持续吐 delta；
- `model-anomaly.ts` 只检测重复工具调用与工具调用预算，纯文本重复不涉及。

第一波持久化的重复文本还会进入后续请求的上下文（第 63 行起的历史回显），
加剧再次退化的倾向。

## 触发条件（重复判定）

对**单次流式响应内**累计的 text delta（不含 reasoning、不含 tool_input），
在文本尾部检测「连续单元重复」：

| 参数             | 值            | 说明                                        |
| ---------------- | ------------- | ------------------------------------------- |
| `MIN_UNIT_CHARS` | 24            | 重复单元最小长度                            |
| `MAX_UNIT_CHARS` | 2048          | 重复单元最大长度（事故中的总结块约 1.8k）   |
| 块级重复次数     | ≥ 4           | 单元包含换行（多行块整体重复）              |
| 墙级重复次数     | ≥ 5           | 单元不含换行（`— — —`、`-----` 等单行墙）   |
| 最小证据量       | ≥ 200 字符    | 计数区 k×L 总长不足则继续观察（围栏外散文） |
| 围栏内证据量     | ≥ 800 字符    | 处于未闭合 ``` 代码围栏内时放宽             |
| 检测间隔         | 每 256 新字符 | 检测在 12KB 滑动窗口内进行                  |

判定为「文本末尾由同一单元连续铺满」，即
`text.endsWith(unit.repeat(k))`、`k` 达到份数阈值、且 k×L 达到当前围栏状态的
证据下限。误杀边界：正常 Markdown 水平线（3~40 字符）、常规表格分隔行
（≤8 列 ≈ 40 字符）、base64 padding、少量引用的重复短行（如 15 字符/行的
轮询文案需连续约 14 行才凑满 200 字符）均不触发；事故级重复（KB 级单元 ×
多份）远超任一下限。

## 状态所有者与事件顺序

```
adapter runStreamText（每次 attempt 独立状态）
  text_delta → 累计窗口 → 每 256 字符检测
  触发：
    1. abort attemptAbortController（终止物理 HTTP 流）
    2. 发布 model_stream_repetition_stopped 状态事件
    3. flush pendingRetrySafeEvents
    4. yield 合成 finish（finishReason "stop" +
       providerMetadata.streamRepetitionGuard = { unitLength, repeatCount,
       trimToIndex, stoppedAtChars }）
    5. 记录 model-io（带 guard error，走有界聚合路径）
    6. return——不重试（同上下文重试必然复发），不进入空回/可疑流判定
core runModelTextRequest（finish 消费方）
  finish.providerMetadata.streamRepetitionGuard 存在：
    1. text 裁剪到 trimToIndex（块级保留 1 份单元，墙级全部丢弃）
    2. 跳过 suspicious-empty 判定（避免裁剪后空文本被误判重试）
    3. 返回结果带 repetitionGuard 字段
turn 层（turn-model-step）
  result.repetitionGuard 存在 → 追加 ModelAnomalyWarning 会话事件
  （category "stream_repetition"）
```

UI 已流式渲染的重复内容以最终持久化消息为准（裁剪后文本），与
「UI 局部状态不是服务端事实」的既有约定一致。

## 配置

- 默认启用；`ZCODE_MODEL_STREAM_REPETITION_GUARD=0`（或 `false`）关闭，
  解析位置与 `ZCODE_MODEL_RETRY_*` 相同（adapter 构造时读 env）。
- 检测阈值是判定质量参数，不暴露为用户配置。

## 边界与不适用

- 只作用于 streamText 流内文本；generateText（整包返回，自会上界）与
  tool_input / reasoning 流不检测（v1 范围，reasoning 循环待后续证据）。
- **轮询等待场景不误杀**：后台任务 for 循环 + 定期 echo 的重复输出属于
  工具输出，不经过模型流事件；等待脚本源码中 echo 文案只出现一次（循环是
  控制结构，不是文本重复）；每轮检测是独立的一次模型请求，护栏状态按
  attempt 重置，跨请求不累计。唯一可能触发的形态是模型在**同一条消息内**
  把同一短行文案连续写约 14+ 行——该形态在文本层面与退化不可区分。
- **文件回显场景**：用户让模型读取并打印含大量重复内容的文件时，工具结果
  （Read/cat 输出）不经过检测器；风险仅在模型于自己正文里逐字回显。回显
  通常落在代码围栏内，围栏内证据下限放宽到 800 字符（约 23 行相同短行），
  常规回显不受影响；超过 800 字符的逐字相同连续段（如 300 行相同错误日志
  的完整回显）仍会触发并裁剪——该形态与围栏内退化在字节层面不可区分，
  取有界保护。有逐行差异的内容（时间戳、递增 id）永不触发。
- compact 流（`preserveProviderStreamBoundaries`）同样受保护：text delta
  走同一检测，触发后的合成 finish 与其消费方语义兼容。
- 触发即终止本 attempt，不消耗 retry 预算、不触发空回重试与流恢复——
  重复退化不是瞬态故障，重放同一上下文只会复发。
- 误触发代价有界：裁剪仅丢失「同单元连续铺满 ≥200 字符」的尾部；正常散文、
  代码块（经 Write 的走 tool_input）不受影响。

## 验收场景

1. 总结块（含换行、≥24 字符）连续重复第 4 份确认时 → 流被终止，
   finish 带 guard 标记，core 文本裁剪到保留 1 份。
2. `— — —` 墙（无换行）累计 ≥200 字符 → 流被终止，墙全部裁掉。
3. 正常输出（普通散文、Markdown 水平线、8 列以内表格、代码说明）→ 不触发。
4. 轮询等待：bash for 循环脚本源码（echo 文案只出现一次）→ 不触发；
   同文案短行连续 12 行（<200 字符）→ 不触发；连续 20 行 → 触发并只保留
   首个检测单元。
5. tool_input_delta / reasoning_delta 携带重复内容 → 不进入检测器
   （只有 text_delta 喂入）。
6. 围栏内回显逐字相同的重复文件内容 <800 字符 → 不触发；≥800 字符 → 触发
   并保留首个检测单元；同样内容在围栏外散文中按 200 字符下限触发。
7. 触发后不产生 retry / 空回重试 / stream recovery；model_request_completed
   正常发布。
8. `ZCODE_MODEL_STREAM_REPETITION_GUARD=0` → 完全旁路（行为与现状一致）。
9. 裁剪后文本为空（极端：从首个字符即退化）→ 不进入 suspicious-empty
   重试，正常结束并告警。
