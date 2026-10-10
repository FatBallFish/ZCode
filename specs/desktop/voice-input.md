# 会话语音输入（本地 ASR + 可选 LLM 整理）

- 状态：v1 实现中（2026-10-11）
- 前置调研：`specs/desktop/voice-input-research.md`
- 相关模块：`packages/shared`（协议/设置/模型清单）、`packages/desktop`（main 语音服务 + utilityProcess 引擎 worker + preload）、`packages/ui`（设置页、会话框麦克风、语音浮窗、语义整理）

## 1. 功能定位

会话框支持本地语音输入：点击麦克风按钮（或按快捷键）开始说话，边说边在底部无边框浮窗里实时显示识别文案；再次点击（或按快捷键）结束，识别结果回填输入框；若用户在设置里开启了「语义整理」并选择了模型，识别完成后自动调用该模型把口语转成干净文案再回填。ESC 或浮窗关闭按钮取消本次输入（丢弃文案）。

- 语音识别完全本地离线（sherpa-onnx 引擎 + 本地模型文件），不上传音频。
- 语义整理按用户配置调用所选模型（复用现有 provider/model 体系，走 `workspace/generateText`）。
- 引擎进程按需加载、空闲自动卸载：不录音时不占内存。

## 2. 模型清单（内置 manifest，文件按需下载）

模型文件存放：`getAppConfigDir()/voice-models/<modelId>/`（`~/.mikiko/v2/voice-models/`）。安装包不打包模型文件（避免安装包膨胀 400MB+）；「内置」指 manifest 内置、首次使用（或设置页预下载）时从 HuggingFace 下载（支持 hf-mirror.com 镜像回退）。

| id                         | 引擎子类型                   | 定位                             | 磁盘   | 运行内存(估) | 语言            | 流式                   |
| -------------------------- | ---------------------------- | -------------------------------- | ------ | ------------ | --------------- | ---------------------- |
| `sensevoice-int8`          | senseVoice（离线+VAD 分段）  | 默认：中英准、极快、自带标点/ITN | ~237MB | 0.5–1GB      | zh/en/ja/ko/yue | 伪流式（分段出字）     |
| `zipformer-bilingual-int8` | streaming transducer（在线） | 低配/真流式备选                  | ~198MB | 0.2–0.5GB    | zh/en           | 真流式（连续 partial） |
| `qwen3-asr-0.6b-int8`      | qwen3Asr（离线+VAD 分段）    | 可选高精度（Apache-2.0）         | ~987MB | 1.5–2.5GB    | 30 语+22 方言   | 伪流式（分段出字）     |

- 共享 VAD 依赖：`silero_vad.onnx`（643,854B，GitHub releases），与 sensevoice/qwen3 一样按需下载到 `voice-models/_vad/`。
- 每个 artifact 记录 `url`（HF resolve）+ `mirrorUrl`（hf-mirror）+ `sizeBytes` + `sha256`（HF LFS oid / 官方发布校验值），下载完成后校验 sha256，失败删除重下；非 LFS 小文件（tokens.txt 等）同样记录 sha256。
- 下载进度经事件推送（按文件累计字节数），UI 在设置页与浮窗「准备中」状态展示。
- 模型删除：设置页支持删除已下载文件回收磁盘（引擎加载中先卸载）。

## 3. 产品行为

### 3.1 设置页（新增「语音输入」菜单，basics 组）

- **语音识别模型**：三选一卡片列表，每项展示名称、特点（语言/流式/标点）、预计磁盘与运行内存、下载状态（未下载/下载中进度/已就绪/校验失败）与操作（下载/删除/设为默认）。
- **语义整理**：开关（默认关）+ 模型选择器。选择器复用 `ModelConfigSelect`（同 OffPeak/子代理的用法：`useModelSelectionServiceView` + `buildRegistryModelSelectGroups`），保存为 `ModelSelection {providerId, modelId}`。开关关闭时选择器置灰但保留选择。
- **快捷键**：展示当前绑定（数据来自 `SHORTCUT_COMMANDS`/`shortcutBindings`，命令 `voiceInput` 默认 `CmdOrCtrl+Shift+V`），点击跳转快捷键设置页（不在本页重复录制，避免两处写入路径）。
- 平台门槛：`process.platform === "win" && arch === "arm64"` 时（sherpa-onnx-node 无 win-arm64 预编译包）整节展示「暂不支持此设备架构」；Web 端不展示该节（v1 桌面限定）。

### 3.2 会话框麦克风按钮与浮窗

- 麦克风图标按钮位于输入框底部左侧动作区（`ConversationComposer` 的 `leadingActionsNode`，紧随 CUA 入口）；空闲态常规 ghost 按钮。
- 点击开始语音输入：按钮持续点亮（品牌色 + 呼吸/脉冲动画），弹出**底部无边框浮窗**（portal 到会话视图 bottom dock 上方，不参与布局挤压）。
  - 浮窗内容：波浪监听动效（多根音条随振幅起伏，`prefers-reduced-motion` 时退化为静态指示）+ 实时识别文案（partial 文本滚动）+ 关闭按钮 + 状态文案（准备中[含下载进度]/监听中/识别中/整理中）。
- 再次点击图标（或快捷键）结束：浮窗进入「识别中」→「整理中」（若开启），完成后文案回填**聚焦会话**的输入框（在现有草稿末尾追加），浮窗关闭、按钮熄灭；输入框在整理期间展示 loading 指示（composer 短暂禁用发送？——否：仅麦克风按钮转 spinner，发送可用原始草稿不受影响）。
- 未开启语义整理：识别完成后直接回填原始文案。
- **取消**：监听中按 ESC（浮窗内 capture keydown）或点关闭按钮 → 停止麦克风、终止会话、丢弃已识别文案、浮窗关闭、按钮熄灭。「识别中/整理中」阶段不可取消（时长秒级）。
- 快捷键（`voiceInput`，window 通道）在任意聚焦态触发同「点击图标」的 toggle；快捷键录制态（`isShortcutRecordingActive`）下不响应。

### 3.3 语义整理管线

- 触发条件：设置开关开 + 已选模型。转录完成后调用 `services.zcodeAgentService.generateWorkspaceText`（既有 `workspace/generateText`，`querySource: "voice-cleanup"`），入参 `messages: [{role:"system", ...},{role:"user", transcript}]`。
- Prompt 约束：删除语气词/口癖/无意义重复与停顿；恢复标点与分段；不改原意、不翻译（中英混说保留原文）；输出只有整理后正文。
- SenseVoice 的情绪/事件标记（`<|laugh|>` 等）由引擎 worker 在产出文本时剥离，不进 LLM。
- 失败降级：整理调用失败/超时（上限 60s + AbortSignal）→ 回填原始转录文案，logger.warn，浮窗正常关闭，不打断用户。
- 转录为空（用户没说话/全是静音）→ 不整理、不回填，浮窗直接关闭并提示「未识别到语音」。

## 4. 状态与所有者

单一所有者原则：

| 状态                                                | 所有者                                               | 说明                                    |
| --------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| 模型文件（下载/删除/校验）                          | desktop main `VoiceService`                          | renderer 只读状态 + 发命令              |
| 引擎 worker 进程（加载/空闲卸载/退出清理）          | desktop main `VoiceService`                          | 全局单 worker，加载唯一模型             |
| 语音会话（feed/finish/cancel、partial/final 事件）  | desktop main `VoiceService`                          | 全局同时最多 1 个活动会话（麦克风互斥） |
| UI 会话状态机（idle/preparing/listening/finishing） | renderer `voiceInputStore`（zustand 单例）           | 快捷键/麦克风按钮/浮窗共用              |
| 麦克风采集（getUserMedia/AudioWorklet/16k 重采样）  | renderer `useVoiceInputController`（App 级单例挂载） | 挂 App root，向 focused workspace 回填  |
| 整理模型选择、开关、识别模型选择                    | `AppSettings`（voiceInput\* 字段）                   | setting.json 持久化                     |

### 状态机（renderer，voiceInputStore）

```
idle ──start()──▶ preparing ──就绪──▶ listening ──stop()──▶ finishing ──回填──▶ idle
                    │                    │  ▲
                    │失败(权限/下载取消)    │ESC/close
                    └──────▶ idle ◀──────┘（丢弃文案）
finishing = transcribing(必经,ms~s 级) → [cleanup(可选,≤60s)] → insertText → idle
```

- `preparing` 包含：确保模型已下载（含进度）→ main 引擎加载 → renderer 麦克风授权。任一步失败回 idle 并以浮窗错误条/按钮 tooltip 展示原因（权限拒绝、下载失败、引擎加载失败）。
- main 侧 `VoiceService.startSession` 在引擎未加载时自动 ensure（含下载）；renderer preparing 阶段监听 `VoiceStateChanged`/`VoiceSessionEvent` 渲染进度。

### 事件顺序（一次完整录音）

```
[renderer] store.start()
  → IPC VoiceStartSession(modelId)            // main: ensure download → ensure worker(model) → session S
  ← event VoiceSessionEvent{S, kind:"engine-loading"|"listening"}
[renderer] getUserMedia → AudioWorklet(16k Int16, 100ms/帧) → IPC VoiceFeedAudio{S, frames}
  ← event VoiceSessionEvent{S, kind:"partial", text}        // worker: VAD 分段→离线识别 / 流式 partial
[renderer] store.stop()
  → IPC VoiceFinishSession{S}
  ← event VoiceSessionEvent{S, kind:"finalizing"}
[worker] 尾段 flush（VAD 强制收尾/流式收尾）→ 整段最终文本
  → IPC resolve VoiceFinishSession → {text, segments, durationMs}
[renderer] （可选）generateWorkspaceText(cleanup)
  → requestComposerTextInsert(focusedWorkspace, text) → idle
[main] 会话结束 → idle 计时（默认 5min）到点 → worker 退出（ unloaded 事件同步设置页）
```

- 幂等/stale：sessionId 由 main 生成（递增+随机）；feed/finish/cancel 校验 sessionId 匹配当前活动会话，不匹配丢弃；renderer 重放（如窗口刷新）时旧会话事件因 sessionId 不匹配自然失效；`finish` 后新 feed 拒绝。
- 退出清理：`prepareAppQuit` 中 `voiceService.dispose()`（杀 worker、取消下载、清理计时器）。会话活动中退出：worker 进程随 app 退出，无持久化状态需要收敛（转录丢失可接受——录音会话本来不落盘）。

## 5. 协议与接口

### 5.1 IPC 通道（`PlatformChannels` + `PlatformChannelMap`）

| 通道                 | 方向   | request → response                                                                                                                |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `VoiceGetState`      | invoke | void → `VoiceStateSnapshot`（模型状态数组 + 引擎 loadedModelId + 活动会话摘要）                                                   |
| `VoiceDownloadModel` | invoke | `{modelId}` → `{ok, error?}`（进度走事件）                                                                                        |
| `VoiceDeleteModel`   | invoke | `{modelId}` → `{ok, error?}`                                                                                                      |
| `VoiceStartSession`  | invoke | `{modelId?}` → `{sessionId}` \| `{error}`（busy/engine/dl-failed/arch）                                                           |
| `VoiceFeedAudio`     | send   | `{sessionId, pcm: Int16Array(base64? → 见下)}；`用 Electron IPC 传 Buffer（structured clone 支持 typed array，直接传 Int16Array） |
| `VoiceFinishSession` | invoke | `{sessionId}` → `VoiceFinalResult{text, segments, durationMs}`                                                                    |
| `VoiceCancelSession` | invoke | `{sessionId}` → void                                                                                                              |
| `VoiceUnloadEngine`  | invoke | void → void（设置页「立即释放」）                                                                                                 |
| `VoiceStateChanged`  | event  | `VoiceStateSnapshot`（模型下载进度/引擎加载/卸载）                                                                                |
| `VoiceSessionEvent`  | event  | `{sessionId, kind, text?, progress?, error?}`                                                                                     |

preload 暴露于 `window.zcode.voice.*`（invoke + `onVoiceStateChanged`/`onVoiceSessionEvent` 订阅，disposer 模式）；`IPlatformService` 增加可选 `voice*` 方法；desktop renderer `desktopPlatform.ts` 实现；UI 经 `usePlatform()` 消费。

### 5.2 shared 类型（`packages/shared/src/voice.ts`）

`VoiceModelManifest`（id/引擎子类型/语言/流式/磁盘内存预估/download{files[{path,url,mirrorUrl,sizeBytes,sha256}]}）、`VoiceModelState`（installed/downloading{progress}/error、lastUsedAt）、`VoiceStateSnapshot`、`VoiceFinalResult`、`VOICE_MODEL_MANIFESTS`（内置清单常量）、zod schema（运行时校验 manifest 与 IPC payload）。语义整理模型存 `AppSettings`：`voiceInputModelId?: string`、`voiceCleanupEnabled?: boolean`、`voiceCleanupSelection?: {providerId, modelId}`（同 `modelSelectionSchema` 形状，不含 reasoningLevel）。

### 5.3 引擎 worker 协议（desktop 包内 `voiceEngineProtocol.ts`，非跨端协议）

utilityProcess 内运行 `voiceEngineWorker.js`：

- main→worker（`postMessage`）：`{type:"load", modelType, modelDir, vadModelPath, numThreads}` / `{type:"feed", sessionId, samples: Float32Array(transfer)}` / `{type:"finish", sessionId}` / `{type:"reset", sessionId}` / `{type:"dispose"}`
- worker→main（`process.parentPort` message）：`{type:"loaded", ...}` / `{type:"partial", sessionId, text}` / `{type:"final", sessionId, text, segments}` / `{type:"error", message}` / `{type:"unloaded"}`
- worker 内部：
  - `senseVoice` / `qwen3Asr`：`Vad`（silero，windowSize 512）滑动分段；每收满一段（speech segment）跑 `OfflineRecognizer.decode`，产出该段文本 → `partial`（累计文本 = 已完成段拼接）；`finish` 时 flush 尾段 + 全段重拼为 `final`。
  - `zipformer`（OnlineRecognizer transducer）：feed 即 decode/poll partial；`finish` 收尾。
  - 情绪/事件标记剥离：`text.replace(/<\|[^|]+\|>/g, "")`。
- 加载耗时与线程：`numThreads = max(1, min(4, cpus-2))`。

## 6. 生命周期与资源

- **懒加载**：首次 `startSession` 才 ensure 下载 + spawn worker；App 启动零语音开销。
- **单实例互斥**：worker 同时只加载一个模型；`startSession` 指定不同模型 → dispose 旧 worker 再起新 worker。
- **空闲卸载**：会话结束 5 分钟无新会话 → worker 退出（常量 `VOICE_ENGINE_IDLE_UNLOAD_MS`）；`VoiceUnloadEngine` 立即卸载（有活动会话时拒绝）。
- **下载互斥**：同模型并发下载请求去重；不同模型可并行但 v1 串行化（一次一个下载队列，简化失败面）。
- worker 崩溃：活动会话报 `engine-error` 事件 → renderer 回 idle + 错误提示；worker 状态标记 unloaded；下次 start 重试拉起。
- sherpa-onnx-node 原生模块：`asarUnpack`（`node_modules/sherpa-onnx*/**`）；worker entry 以 `utilityProcess.fork` 加载（与 host 进程同模式）。

## 7. 边界与降级

1. 无麦克风/权限拒绝：`getUserMedia` 失败 → preparing 失败，浮窗错误条「麦克风不可用」。
2. 下载失败（断网/校验失败）：保留 `.part` 临时文件机制（下载到 `<file>.part`，校验通过后 rename），失败清理；可重试。
3. Windows arm64：模型清单标记不可用，start 返回 `arch-unsupported`。
4. 活动会话期间第二个入口（快捷键/另一窗口）：main 返回 `busy`——同一窗口的 toggle 语义在 renderer 层短路（store 状态已 listening 时 stop），跨窗口由 main busy 兜底，浮窗不弹。
5. 语义整理模型未配置/连接不可用：回填原始文案（整理失败同路径）。
6. 快捷键冲突：交给现有快捷键冲突检测；`voiceInput` 出现在快捷键设置页命令表，可改绑。
7. 录音超长：VAD 分段天然分块；单会话不设上限，转录内存为文本累计（可接受）。
8. 音频格式：统一 16kHz mono Int16；AudioContext 尝试 `{sampleRate:16000}`，失败回退默认采样率 + worklet 内线性重采样。
9. 手机远控/Web：v1 不启用（浮窗与麦克风按钮仅 desktop 渲染）。

## 8. 验收场景

1. 首次使用：设置页显示三模型卡（sensevoice 默认选中、qwen3 未下载）→ 会话框点麦克风 → 浮窗「准备中(下载 xx%)」→ 下载完成自动进入监听 → 说中文出中文、说英文出英文、混说保留原文 → 再点图标 → 文案回填输入框，浮窗关闭。
2. 开启语义整理：说一段带语气词/重复的中文 → 回填的是整理后干净文案；关闭整理开关 → 回填原始转录。
3. 整理失败（断网所选 provider）：回填原始转录，无报错弹窗，日志 warn。
4. ESC/关闭按钮：监听中取消 → 无文案回填，麦克风按钮熄灭，设置页模型状态不变。
5. 快捷键：默认 `CmdOrCtrl+Shift+V` 唤起/停止；改绑后在快捷键设置页生效；录制快捷键时 voiceInput 不触发。
6. 空闲卸载：录音结束 5 分钟后（或设置页「立即释放」）设置页引擎状态变「未加载」，`ps` 无 voice worker 进程；再次录音自动拉起。
7. 模型切换：选中 zipformer → 下次录音 worker 重启加载 zipformer（浮窗出字节奏变为连续 partial）；下载 qwen3 → 切换 → 高精度出字；删除模型文件回收磁盘。
8. 下载失败：断网下载 → 进度停滞/失败可重试；校验失败自动清理重下。
9. 双窗口：A 窗录音中 B 窗点麦克风 → B 提示忙碌不弹浮窗。
10. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过；新增单测（manifest 完整性、worker 协议序列化、voice store 状态机、下载状态机 fake fetch）全绿。

## 9. 许可与署名

- sherpa-onnx（Apache-2.0）、sherpa-onnx-node（Apache-2.0）：THIRD-PARTY-NOTICES 增补。
- SenseVoice-Small 权重（FunASR Model Open Source License v1.1）与 zipformer 模型（k2-fsa 训练，Apache-2.0）、Qwen3-ASR（Apache-2.0）：设置页模型卡展示来源与许可；NOTICE 增补 FunASR 署名条款（保留模型名）。
