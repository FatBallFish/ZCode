# 会话语音输入（本地 ASR + 可选 LLM 整理）

2026-10-21 UI 回归合同：整理模型选择使用会话 `ModelConfigSelect` 的 `ComposerModelMenu` 供应商/模型两层视图，不能落回旧供应商悬浮子菜单。候选仍来自本地 workspace 的 ModelSelectionView（账号、自定义、中转站和 ChatGPT 标签全部保留）；选中模型只更新 voiceCleanupSelection，不切换会话连接、不发模型请求。整理用途仍锁定所选模型的最低思考档，不展示可调思考滑杆。禁用整理时入口禁用，设置页始终显示当前模型名。浅/深主题、两种语言及自定义分组选择都需真实 UI 验证。

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
- 点击开始语音输入：按钮持续点亮（品牌色填充 `bg-brand` + 前景反色 + `animate-pulse` 呼吸动画；仅 `text-brand` 色调在浅色主题下与常态几乎不可辨，真机 E2E 实测不达标），弹出**底部无边框浮窗**。
  - 浮窗为 App 级 fixed 浮层，**运行时测量 composer 顶边锚定其上方**（查询 `[data-testid="v4-composer"]` 的 `getBoundingClientRect().top`，`bottom = 视口高 - top + 12px`，下限 16px；窗口 resize 重算）。固定 `bottom-36` 的写法在草稿态会压到 composer 下方的建议 chips 区（真机 E2E 实测），仅作找不到 composer 时（如设置页错误提示态）的回退。浮层不参与布局挤压。
  - 浮窗内容：波浪监听动效（多根音条随振幅起伏，`prefers-reduced-motion` 时退化为静态指示）+ 实时识别文案（partial 文本滚动）+ 关闭按钮 + 状态文案（准备中[含下载进度]/监听中/识别中/整理中）。
- 再次点击图标（或快捷键）结束：浮窗进入「识别中」→「整理中」（若开启），完成后文案回填**聚焦会话**的输入框（在现有草稿末尾追加），浮窗关闭、按钮熄灭；输入框在整理期间展示 loading 指示（composer 短暂禁用发送？——否：仅麦克风按钮转 spinner，发送可用原始草稿不受影响）。
- 未开启语义整理：识别完成后直接回填原始文案。
- **取消**：监听中按 ESC（浮窗内 capture keydown）或点关闭按钮 → 停止麦克风、终止会话、丢弃已识别文案、浮窗关闭、按钮熄灭。「识别中/整理中」阶段不可取消（时长秒级）。
- **错误态可关闭**（`error` phase）：关闭按钮、ESC、再次点击麦克风均立即消隐错误并回 idle（不立刻开始新录音，防误触连开）；3s 自动消隐保留。曾出现「空结果提示一直显示、点取消无反应」——错误态所有关闭路径都路由到 controller.cancel，旧实现只在 preparing/listening 生效，error 态全部失效。
- 快捷键（`voiceInput`，window 通道）在任意聚焦态触发同「点击图标」的 toggle；快捷键录制态（`isShortcutRecordingActive`）下不响应。

### 3.3 语义整理管线

- 触发条件：设置开关开 + 已选模型。转录完成后调用 `services.zcodeAgentService.generateWorkspaceText`（既有 `workspace/generateText`，`querySource: "voice-cleanup"`），入参 `messages: [{role:"system", ...},{role:"user", transcript}]`。
- **模型选择携带思考档位**：要求档位的模型（如 GLM 系 coding plan）不带 `options.reasoningLevel` 会被 RPC 直接拒绝（实测 "Reasoning level is required"），整理静默降级为原文。规则：
  - `voiceCleanupSelection` 含可选 `reasoningLevel`；
  - 设置页选中模型时经 `completeNewModelSelection` 补默认档位（最高档）一并保存；
  - 运行时兜底：已存选择缺档位时经 base host 的 `modelSelectionService.getView()` 懒补
    默认档位再调用（旧数据无需迁移；视图不可用则按原样发出，由 RPC 错误路径降级回填原文 + warn）。
- **整理模型候选 = 活动工作区的模型视图**（`useModelSelectionView`，与自动化设置同源）：含账号系、中转站（Sub2API）与自定义供应商；不用 base host 视图（只有账号系，中转站模型全部缺席——实测踩坑）。无活动本地工作区时下拉禁用。
- Prompt 约束：删除语气词/口癖/无意义重复与停顿；恢复标点与分段；不改原意、不翻译（中英混说保留原文）；输出只有整理后正文。
- SenseVoice 的情绪/事件标记（`<|laugh|>` 等）由引擎 worker 在产出文本时剥离，不进 LLM。
- 失败降级：整理调用失败/超时（上限 60s + AbortSignal）→ 回填原始转录文案，logger.warn，浮窗正常关闭，不打断用户。
- 转录为空（用户没说话/全是静音）→ 不整理、不回填，浮窗进入错误态提示「未识别到语音」（可关闭/3s 自动消隐，见 §3.2 错误态）。

### 3.4 输入设备选择

- 设置页「输入设备」下拉：`navigator.mediaDevices.enumerateDevices()` 过滤 `audioinput`；首项固定「使用系统默认」（value `""`，跟随系统默认输入设备），其余按 `label`（未授权时 label 为空，显示「输入设备 N」占位——首次录音授权后即可见名称）。
- 选择持久化 `AppSettings.voiceInputDeviceId`（`""`/缺省 = 系统默认）；监听 `devicechange` 事件刷新列表。
- 采集约束：`getUserMedia({ audio: { deviceId: { exact: <选中值> }, ... } })`；设备已拔出时抛 `OverconstrainedError` → 回退一次系统默认（不中断本次录音），logger.warn 记录。选中设备从列表消失时保留设置值（下拉显示占位），采集回退逻辑兜底。

### 3.5 麦克风权限（macOS TCC）

- **开始录音前预检**（含切换输入设备后的首次录音，统一走 begin 入口）：renderer 调 `voiceEnsureMicPermission`（main 侧 `systemPreferences`）：
  - `granted` → 继续开录；
  - `not-determined` → main 调 `askForMediaAccess("microphone")`（Electron 41+ API 名）弹系统授权框，返回最终状态；
  - `denied`/`restricted` → 不再发起 getUserMedia（必然失败），浮窗错误态 `voice.error.micDenied`，并附「去开启」按钮直接跳系统设置的麦克风隐私面板。
- **设置页权限状态行**：展示当前状态（已授权/未授权/尚未请求），未授权时提供「去系统设置开启」按钮与提示文案：**系统设置中开启后如仍无法录音，需重启应用生效**（macOS TCC 对运行中进程的授权变更不即时生效）。
- **「去开启」按钮行为**（VoiceOpenMicPermissionSettings，按平台）：
  - macOS：**先补一次 TCC 请求再跳设置**——`not-determined` 时调 `askForMediaAccess`（系统授权框直接点“允许”即完成授权，无需进设置；点“不允许”也会把本应用写入麦克风列表，避免列表里找不到应用而需手动添加）。`denied`（记录已存在）直接跳 `Privacy_Microphone` 面板。返回最终 status，授权成功时浮窗自动消隐、设置页即时刷新。
  - Windows：无逐应用 TCC（桌面应用受全局“桌面应用访问麦克风”开关控制），跳 `ms-settings:privacy-microphone`。
  - Linux：无统一权限体系（普通构建无需授权），no-op。
  - **API 名（Electron 41+）**：申请用 `systemPreferences.askForMediaAccess(mediaType)`——旧名 `askForMediaAccessPermission` 不存在，调用同步抛 TypeError；ensure 的 catch 会把它映射成 denied，表象是"瞬间被拒、永不弹框"（真机踩坑）。注入式单测掩盖过此错名，IPC 装配处注释已标注。
  - **TCC 弹框的 responsibility 门槛（tccd 日志实证）**：弹框归属按"责任进程"（responsible）判定。hardened runtime 的责任进程缺少 `com.apple.security.device.audio-input` entitlement 时，tccd 策略**直接拒绝且不弹框**（`Policy disallows prompt`），TCC 库不留记录、设置列表无入口。因此：
    - 正式包 entitlements（`build/entitlements.mac.plist` + `inherit`）必须包含 `com.apple.security.device.audio-input`；
    - 从 ZCode.app 内（如 agent 子进程）启动的 dev 实例，责任进程是未带该 entitlement 的宿主 ZCode.app，弹框被禁——**验证麦克风授权流程必须从用户自己的终端启动 `pnpm dev:desktop`**（责任进程为终端，正常弹框）。曾被误判为 dev bundle 签名问题并加过 ad-hoc 重签名，已证伪回退（无签名副本被 macOS 按"未签名应用"正常弹框）。
- Windows/Linux：无 macOS 式预检（`voiceGetMicPermissionStatus` 返回 `unsupported`，设置页不显示权限行），授权交给 getUserMedia 的系统级提示；Windows 上反复 NotAllowedError 时经「去开启」跳全局麦克风隐私设置。

## 4. 状态与所有者

单一所有者原则：

| 状态                                                | 所有者                                               | 说明                                    |
| --------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| 模型文件（下载/删除/校验）                          | desktop main `VoiceService`                          | renderer 只读状态 + 发命令              |
| 引擎 worker 进程（加载/空闲卸载/退出清理）          | desktop main `VoiceService`                          | 全局单 worker，加载唯一模型             |
| 语音会话（feed/finish/cancel、partial/final 事件）  | desktop main `VoiceService`                          | 全局同时最多 1 个活动会话（麦克风互斥） |
| UI 会话状态机（idle/preparing/listening/finishing） | renderer `voiceInputStore`（zustand 单例）           | 快捷键/麦克风按钮/浮窗共用              |
| 麦克风采集（getUserMedia/AudioWorklet/16k 重采样）  | renderer `useVoiceInputController`（App 级单例挂载） | 挂 App root，向 focused workspace 回填  |
| 整理模型选择、开关、识别模型选择、输入设备选择      | `AppSettings`（voiceInput\* 字段）                   | setting.json 持久化                     |
| 输入设备枚举（enumerateDevices/devicechange）       | renderer（Web API，会话页/设置页共用）               | device label 依赖已授权                 |
| 麦克风权限状态查询/系统授权框/跳系统设置            | desktop main（`systemPreferences`/`shell`）          | renderer 只读状态 + 发命令              |

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
- **尾帧冲刷（2026-10-12）**：worklet 按 100ms 整帧输出，停止录音时重采样累加器里 <100ms 的尾部语音若直接停麦会被丢弃（用户反馈「最后半句没识别就返回」）。`finish()` 先向 worklet 发 `{type:"flush"}`（补发剩余样本为一帧，先于 `flushed` 应答发出），等应答（150ms 超时兜底）+ 一个宏任务后再 stopMic 并 invoke `VoiceFinishSession`——worker 先收齐全部音频再收到 finish，尾部识别完整后才回 final；期间浮窗保持 finishing 态。`cancel()` 不冲刷（丢弃语义）。
- **音浪电平（2026-10-12）**：worklet 每帧计算 RMS 随 `{type:"frame", frame, rms}` 一并回传；controller 写入 `voiceInputStore.audioLevel`（仅渲染态）。浮窗音浪 rAF 读取做 attack/decay 包络 + 相位交错摆动；低于阈值（0.015）视为无声，音条回落贴底静止（无波纹）；`prefers-reduced-motion` 退化为静态音条。

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

| 通道                             | 方向   | request → response                                                                                                                          |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `VoiceGetState`                  | invoke | void → `VoiceStateSnapshot`（模型状态数组 + 引擎 loadedModelId + 活动会话摘要）                                                             |
| `VoiceDownloadModel`             | invoke | `{modelId}` → `{ok, error?}`（进度走事件）                                                                                                  |
| `VoiceDeleteModel`               | invoke | `{modelId}` → `{ok, error?}`                                                                                                                |
| `VoiceStartSession`              | invoke | `{modelId?}` → `{sessionId}` \| `{error}`（busy/engine/dl-failed/arch）                                                                     |
| `VoiceFeedAudio`                 | send   | `{sessionId, pcm: Int16Array(base64? → 见下)}；`用 Electron IPC 传 Buffer（structured clone 支持 typed array，直接传 Int16Array）           |
| `VoiceFinishSession`             | invoke | `{sessionId}` → `VoiceFinalResult{text, segments, durationMs}`                                                                              |
| `VoiceCancelSession`             | invoke | `{sessionId}` → void                                                                                                                        |
| `VoiceUnloadEngine`              | invoke | void → void（设置页「立即释放」）                                                                                                           |
| `VoiceGetMicPermissionStatus`    | invoke | void → `{status: "granted"\|"denied"\|"not-determined"\|"restricted"\|"unsupported"}`（macOS TCC 查询，不弹框；非 darwin 返回 unsupported） |
| `VoiceEnsureMicPermission`       | invoke | void → `{status}`；`not-determined` 时弹系统授权框（`askForMediaAccess`）后返回最终状态；非 darwin 恒 granted                               |
| `VoiceOpenMicPermissionSettings` | invoke | void → void；打开系统设置麦克风隐私面板（仅 darwin 有意义）                                                                                 |
| `VoiceStateChanged`              | event  | `VoiceStateSnapshot`（模型下载进度/引擎加载/卸载）                                                                                          |
| `VoiceSessionEvent`              | event  | `{sessionId, kind, text?, progress?, error?}`                                                                                               |

preload 暴露于 `window.zcode.voice.*`（invoke + `onVoiceStateChanged`/`onVoiceSessionEvent` 订阅，disposer 模式）；`IPlatformService` 增加可选 `voice*` 方法；desktop renderer `desktopPlatform.ts` 实现；UI 经 `usePlatform()` 消费。

### 5.2 shared 类型（`packages/shared/src/voice.ts`）

`VoiceModelManifest`（id/引擎子类型/语言/流式/磁盘内存预估/download{files[{path,url,mirrorUrl,sizeBytes,sha256}]}）、`VoiceModelState`（installed/downloading{progress}/error、lastUsedAt）、`VoiceStateSnapshot`、`VoiceFinalResult`、`VOICE_MODEL_MANIFESTS`（内置清单常量）、zod schema（运行时校验 manifest 与 IPC payload）。语义整理模型存 `AppSettings`：`voiceInputModelId?: string`、`voiceInputDeviceId?: string`（`""`/缺省 = 系统默认输入设备）、`voiceCleanupEnabled?: boolean`、`voiceCleanupSelection?: {providerId, modelId, reasoningLevel?}`（执行时映射为 `options.reasoningLevel`，见 §3.3）。

### 5.3 引擎 worker 协议（desktop 包内 `voiceEngineProtocol.ts`，非跨端协议）

utilityProcess 内运行 `voiceEngineWorker.js`：

- main→worker（`postMessage`）：`{type:"load", modelType, modelDir, vadModelPath, numThreads}` / `{type:"feed", seq, samples: Float32Array（structured clone 拷贝；utilityProcess.postMessage 的 transfer 只支持 MessagePortMain，传 ArrayBuffer 会抛 "not a valid port" 打崩 main）}` / `{type:"finish", seq}` / `{type:"reset"}` / `{type:"dispose"}`
- worker→main（`process.parentPort` message）：`{type:"loaded", ...}` / `{type:"partial", sessionId, text}` / `{type:"final", sessionId, text, segments}` / `{type:"error", message}` / `{type:"unloaded"}`
- worker 内部：
  - `senseVoice` / `qwen3Asr`：`Vad`（silero，windowSize 512）滑动分段；每收满一段（speech segment）跑 `OfflineRecognizer.decode`，产出该段文本 → `partial`（累计文本 = 已完成段拼接，**文本变化才发**，静默期不刷）；`finish` 时 flush 尾段 + 全段重拼为 `final`。
  - **VAD 喂入必须按 windowSize(512) 分块**：`acceptWaveform` 单次调用不会完整消化任意长度输入（实测 1s 静音整帧一次喂入不触发分段、按 512 分块喂入正常；整帧直喂会让 VAD 以远低于实时的速度消费，语音段永远无法按时闭合——曾导致 partial 完全不出字，只有 finish 的 flush 兜底）。IPC 帧长（100ms/1600 采样）与 VAD 消费粒度解耦：worker 内统一重切块。
  - 跨段拼接：相邻段以拉丁字母/数字相接时补一个空格（"hello world" + "this is" 不粘连）；中文直接连接。
  - `zipformer`（OnlineRecognizer transducer）：feed 即 decode/poll partial（文本变化才发）；`finish` 收尾。
  - 情绪/事件标记剥离：`text.replace(/<\|[^|]+\|>/g, "")`；SenseVoice 全大写英文仅在文本拉丁字母 100% 大写时逐词小写（混排缩写不受影响）。
- 加载耗时与线程：`numThreads = max(1, min(4, cpus-2))`。

## 6. 生命周期与资源

- **懒加载**：首次 `startSession` 才 ensure 下载 + spawn worker；App 启动零语音开销。
- **单实例互斥**：worker 同时只加载一个模型；`startSession` 指定不同模型 → dispose 旧 worker 再起新 worker。
- **空闲卸载**：会话结束 5 分钟无新会话 → worker 退出（常量 `VOICE_ENGINE_IDLE_UNLOAD_MS`）；`VoiceUnloadEngine` 立即卸载（有活动会话时拒绝）。
- **下载互斥**：同模型并发下载请求去重；不同模型可并行但 v1 串行化（一次一个下载队列，简化失败面）。
- worker 崩溃：活动会话报 `engine-error` 事件 → renderer 回 idle + 错误提示；worker 状态标记 unloaded；下次 start 重试拉起。
- sherpa-onnx-node 原生模块：`asarUnpack`（`node_modules/sherpa-onnx*/**`）；worker entry 以 `utilityProcess.fork` 加载（与 host 进程同模式）。

## 7. 边界与降级

1. 无麦克风/权限拒绝：macOS 先走 §3.5 预检（denied 直接引导，不烧一次会话启动）；预检通过后 `getUserMedia` 失败 → preparing 失败，浮窗错误条「麦克风不可用」。
2. 下载失败（断网/校验失败）：保留 `.part` 临时文件机制（下载到 `<file>.part`，校验通过后 rename），失败清理；可重试。
3. Windows arm64：模型清单标记不可用，start 返回 `arch-unsupported`。
4. 活动会话期间第二个入口（快捷键/另一窗口）：main 返回 `busy`——同一窗口的 toggle 语义在 renderer 层短路（store 状态已 listening 时 stop）；跨窗口由 main busy 兜底，后触发窗口的浮窗短暂显示「忙碌」错误后自动关闭（约 3s；比无反馈更友好）。`startSession` 在 main 侧整体串行化：busy 判定与 activeSession 赋值之间隔着下载/引擎加载等多个 await，串行链 + 复检彻底关死双 worker 竞态。
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
10. 空结果可关闭：开录音后不说话直接停 → 「未识别到语音内容」出现；点关闭按钮/ESC/再点麦克风任一方式立即消隐，且下一次点击麦克风可立即重新开录。
11. 输入设备：设置页下拉含「使用系统默认」+ 全部 audioinput；选中指定设备后录音走该设备；拔出该设备后开录自动回退系统默认（日志 warn）不失败；插拔设备下拉列表即时刷新。
12. 麦克风权限（macOS）：未授权状态开录 → 弹系统授权框，拒绝后浮窗提示未授权并可一键跳系统设置；设置页权限行展示状态并可引导；系统设置中改为允许后按提示重启应用可正常录音。
13. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过；新增单测（manifest 完整性、worker 协议序列化、voice store 状态机、下载状态机 fake fetch、麦克风权限状态映射）全绿。

## 9. 许可与署名

- sherpa-onnx（Apache-2.0）、sherpa-onnx-node（Apache-2.0）：THIRD-PARTY-NOTICES 增补。
- SenseVoice-Small 权重（FunASR Model Open Source License v1.1）与 zipformer 模型（k2-fsa 训练，Apache-2.0）、Qwen3-ASR（Apache-2.0）：设置页模型卡展示来源与许可；NOTICE 增补 FunASR 署名条款（保留模型名）。
