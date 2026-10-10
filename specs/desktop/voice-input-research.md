# 语音输入（语音转义）本地模型调研报告

- 日期：2026-10-11
- 状态：调研结论（未含实现）
- 范围：可本地部署 / 端侧部署的开源语音识别（ASR）方案，面向 ZCode 会话框语音输入功能
- 结论消费者：`specs/desktop/voice-input.md`（后续正式 spec）、`packages/shared`、`packages/desktop`、`packages/ui`

## 1. 需求回顾

用户在会话框开启语音输入，说完后自动识别转义为文字；若用户在 App 内配置了「转义整理用 AI API KEY」，转义文本自动交给文本大模型整理输出。

| # | 需求 | 级别 |
|---|---|---|
| 1 | 轻量化，低设备配置可运行，可集成进 App | 必要 |
| 2 | 中文、英文识别准确（其他语言可暂缓） | 必要 |
| 3 | 实时语音输入（边说边出字）；最差也要整段录音转义 | 期望实时，保底整段 |
| 4 | 语气词、停顿词、重复叠词整理为干净文案 | 可选（计划由文本 LLM 完成） |
| 5 | 不因语音功能常驻占用大量 CPU / 内存 | 新增（本次补充） |
| 6 | 多模型可切换，通用抽象接口接入；前期优先「体积小、占用低、中英快而准」的离线模型 | 新增（本次补充） |

## 2. 结论总览（TL;DR）

1. **统一运行时选 sherpa-onnx（k2-fsa，Apache-2.0）**：单一二进制 / Node 原生 addon 即可承载多个模型，不需要附带任何「语音模型服务」。官方支持 macOS x64+arm64、Windows x64+x86+arm64、Linux x64+aarch64+arm+riscv64、Android、iOS、WASM。
2. **首期接入三个模型（同一引擎、按需下载）**：
   - 默认：**SenseVoice-Small int8**（磁盘约 240MB，中英精准、非自回归极快、自带标点与情绪/事件标记）；
   - 低配/真流式备选：**Zipformer 中英双语 streaming int8**（约 80–250MB，真流式）；
   - 可选高精度：**Qwen3-ASR-0.6B int8**（磁盘约 0.7–1GB，Apache-2.0，中文准确率数倍优于 Whisper-large-v3）。
3. **实时性方案：VAD 分段 + 快速离线模型逐段出字（伪流式）**，分段延迟数百毫秒级，不需要第一版就上真流式模型；说完后对整段录音重转一遍作为最终文本。
4. **按需加载/卸载完全可行**：推荐 sidecar 子进程模式（进程退出 = 内存彻底释放），配合懒加载 + 空闲自动卸载 + 单实例互斥，做到「不用时不占一字节内存」。
5. **FunASR 定位：模型来源与服务端方案，不做 App 内嵌**。它的模型（Paraformer、SenseVoice）都能被 sherpa-onnx 直接复用；其 websocket runtime 需要 1.5–2.5GB 内存和独立服务进程，与「不附带语音服务」诉求冲突。
6. **语气词/叠词整理交给用户配置的文本 LLM**，ASR 层不做改写（方案见 §9）。

## 3. 候选模型全景

### 3.1 中文准确率对比（AISHELL-1 CER，越小越好）

数据来源：第三方深度实测（ruoqijin.com，2026）+ 官方模型卡。AISHELL-1 是朗读新闻语料，真实口语场景通常有 3–7 倍劣化，仅用于横向排序。

| 模型 | 体积 | AISHELL-1 CER | WenetSpeech 会议 WER | 流式 | 许可 |
|---|---|---|---|---|---|
| FireRedASR2-AED | 1.1B | 0.57%（SOTA） | 4.53% | 否 | 需查证（非标准开源） |
| Qwen3-ASR-1.7B | 1.7B | ~1.48% | 5.88% | 伪流式（92ms TTFT，bug #129） | Apache-2.0 |
| Qwen3-ASR-0.6B | ~0.9B | 强于 Whisper 数倍（KeSpeech 7.08 vs 28.79） | 4.97（net） | 伪流式 | Apache-2.0 |
| Paraformer-Large | 220M | 1.68% | — | 是（2-pass，480–600ms） | FunASR License v1.1 |
| SenseVoice-Small | 234M | 2.96% | — | 否（VAD 分段伪流式） | 代码 MIT / 权重 FunASR v1.1 |
| Whisper large-v3 | 1.55B | 5.14% | 18.87% | 否（滑窗 ~3.3s 起） | MIT |
| Vosk small-cn | 42MB | 一般（老架构） | — | 是 | Apache-2.0 |

英文侧：Whisper large-v3-turbo（4.8% AA-WER）、NVIDIA Canary-Qwen 2.5B（4.4%）领先，但两者中文弱或不支持中文；中英混说场景 Qwen3-ASR 最优（52 语言 + 22 方言）。

### 3.2 各候选简评

- **SenseVoice-Small**（阿里 FunAudioLLM）：234M 非自回归，zh/en/ja/ko/yue，官方称比 Whisper-Large 快 15 倍、比 Whisper-Small 快 5 倍；输出带标点与情绪/音频事件标记；可跑树莓派。体积/速度/准确率三角最优的默认选择。
- **Qwen3-ASR-0.6B**（2026-01 开源）：Apache-2.0 最干净许可；0.6B 为官方定位的「精度-效率折中、端侧友好」型号；支持 30 语言 + 22 中文方言；中文大幅优于 Whisper。缺点：LLM 解码器架构，体积与内存是 SenseVoice 的 3–5 倍，伪流式有无限重复 bug（官方 issue #129），做实时上屏需规避。
- **Zipformer 双语 streaming**（Next-gen Kaldi）：sherpa-onnx 原生真流式（chunk 可配，延迟约 0.3–0.8s），int8 后体积最小，准确率低于上面的离线模型。适合「低配设备 + 真流式」诉求与兜底。
- **Paraformer-Large / FunASR 2-pass**：中文效率冠军（RTF ~0.008，CPU 可跑），生产级流式最成熟，但经典部署形态是 websocket 服务（见 §4）。
- **Whisper 系（whisper.cpp / faster-whisper / WhisperKit）**：生态最成熟、许可最干净（MIT）、英文强，但中文 CER 落后中文专用模型 2–10 倍。作为多语种兜底引擎保留扩展位，不做主力。
- **FireRedASR2（小红书，2026-03）**：中文 SOTA，但 AED 版需 4–6GB 显存且有 60s 输入限制，纯服务端定位，排除出首期。
- **Vosk**：42MB 超轻量真流式，中文准确率一般，保留为极限低配兜底提及，不推荐主力。
- **Moonshine / Parakeet / Canary**：无中文或中文弱，排除（Moonshine-tiny-zh 为社区变体，生态弱）。

## 4. FunASR 专项调研（补充 1）

**项目**：[modelscope/FunASR](https://github.com/modelscope/FunASR)，ModelScope（阿里）开源语音工具箱，约 20.6k stars。覆盖离线/流式/端侧 ASR、VAD、标点、说话人、情绪/音频事件识别，是**模型与训练工具箱**而非单一模型。

**许可**：代码 MIT；模型权重逐个授权，官方权重多采用 FunASR Model Open Source License Agreement v1.1（商用可用，附署名/保留模型名条款；第三方转换包可能不同，逐模型卡核对）。

**模型库（与本项目相关的）**：
- Paraformer-zh（220M，离线 + 时间戳）/ Paraformer-zh-streaming（流式）
- SenseVoiceSmall（234M，含 GGUF 版）
- Fun-ASR-Nano（800M，zh/en/ja + 方言）/ Fun-ASR-MLT-Nano（31 语言，2026 新）
- Qwen3-ASR（1.7B）、GLM-ASR-Nano（1.5B）等第三方模型托管
- 配套小件：fsmn-vad（0.4M）、ct-punc 标点（290M）、cam++ 说话人（7.2M）、emotion2vec+large（300M）

**部署形态与资源（关键差异点）**：

| 形态 | 说明 | 资源（官方/社区实测） | 平台 |
|---|---|---|---|
| Python AutoModel | pip + PyTorch，研究/批处理 | CPU 可跑；需 Python+PyTorch 运行时 | 三平台（Python 层） |
| websocket runtime SDK（2-pass） | C++ / ONNX 独立服务进程，集成 VAD+流式+标点+ITN | 常驻内存约 1.5–2.5GB；4C8G 单机约 16 路并发、16C32G 约 32 路；流式延迟约 600ms | Linux x64/aarch64（Docker 官方镜像）+ Windows x64 CPU 包；**macOS 无官方 runtime** |
| OpenAI 兼容 server / vLLM / MCP | 面向云端服务化 | GPU 为主（并发 128 时约 2000x 实时吞吐） | 服务器 |
| GGUF / llama.cpp 单二进制 | 2026 新路线（SenseVoice GGUF 等），CPU/边缘单文件 | 自带 FSMN-VAD；官方称中文 CER 约为 whisper.cpp 的 1/3 | Linux/macOS/Windows x64（Vulkan/CUDA 包） |

**结论**：
- FunASR 的价值对本项目是**模型来源**（Paraformer、SenseVoice、fsmn-vad、ct-punc 都出自这里），其模型均有 ONNX 导出、可被 sherpa-onnx 直接加载——不必引入 FunASR 本身的任何运行时。
- 其经典 2-pass websocket runtime 是**服务端形态**：独立进程 + 1.5–2.5GB 常驻 + Docker/平台覆盖不全，不符合「App 不附带语音模型服务」的诉求，**不内嵌**。
- 可留一个「远端模式」扩展位：用户自建 FunASR 2-pass 或 OpenAI 兼容服务时，ZCode 仅作为 websocket 客户端接入（见 §7）。
- GGUF/llama.cpp 路线体积小、中文准，但生态较新（构建/发布链路待成熟），列为观察项。

## 5. 资源占用与平台支持矩阵（补充 2）

> 数值标注置信度：`官方` = 官方文档/模型卡；`实测` = 第三方实测；`估算` = 按参数量/文件体积推算，POC 时必须复核。运行内存按 int8 单实例、不含 App 自身。

| 模型（运行时） | 磁盘体积 | 运行内存 | 纯 CPU | 出字效率 | 离线 | macOS x64/arm64 | Windows x64/arm64 | Linux x64/arm64 | 集成方式 |
|---|---|---|---|---|---|---|---|---|---|
| **SenseVoice-Small int8**（sherpa-onnx） | ~240MB（int8；fp32 约 950MB）`官方` | 约 0.5–1GB `估算` | ✅ | 官方称快于 Whisper-Large 15 倍；树莓派 4 可跑（多线程）`官方/实测` | ✅ | ✅ / ✅ `官方` | ✅ / ✅ `官方` | ✅ / ✅ `官方` | sidecar 或 NAPI addon，**零附带服务** |
| **Qwen3-ASR-0.6B int8**（sherpa-onnx） | ~0.7–1GB `实测` | 约 1.5–2.5GB `估算` | ✅（有 ONNX CPU EP 比 WebGPU 快 4 倍的实测案例）`实测` | GPU 并发 128 下 2000x 实时`官方`；CPU 单路短音频需 POC 实测 | ✅ | ✅ / ✅（随 sherpa-onnx） | ✅ / ✅ | ✅ / ✅ | 同上 |
| **Zipformer 双语 streaming int8**（sherpa-onnx） | ~80–250MB（视变体，按 model zoo 核对）`官方` | 约 0.2–0.5GB `估算` | ✅ | 真流式延迟约 0.3–0.8s；RTF 远小于 1 `实测` | ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | 同上 |
| Paraformer 2-pass（FunASR websocket runtime） | 模型数百 MB | **1.5–2.5GB 常驻**`实测` | ✅（RTF ~0.03–0.1） | 4C8G 16 并发、延迟约 600ms `官方` | ✅ | ❌ 无官方 runtime | ✅ / ❌ 仅 x64 包 | ✅ / ✅（Docker） | 需附带独立服务进程，**不符合诉求** |
| Whisper 系（whisper.cpp sidecar） | tiny ~75MB / small ~466MB / turbo ~1.6GB `官方` | tiny ~0.2GB / small ~0.5GB / turbo 1.5–2GB+ `估算` | ✅ | small 现代 CPU RTF<0.5；turbo 手机可实时听写 `实测`；流式滑窗延迟 3.3s 起 `实测` | ✅ | ✅ / ✅（Metal） | ✅ / ⚠️ 需自行编译 | ✅ / ✅ | 单二进制 sidecar（零附带服务，但中文弱） |
| Vosk small-cn | 42MB `官方` | ~0.2–0.4GB `估算` | ✅ | RTF 低、真流式 | ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | native/JNI 库或 sidecar |
| FireRedASR2-AED | 1.1B | 需 4–6GB **显存**、60s 输入限制 `实测` | ❌（实践上） | — | ✅ | 服务端 | 服务端 | 服务端 | 排除（服务端定位） |

**平台矩阵说明**：
- sherpa-onnx 官方文档明确：Linux（x64、aarch64、arm、riscv64）、macOS（x64、arm64）、Windows（x64、x86、arm64）、Android（arm64-v8a、armv7、x86、x86_64）、iOS（arm64）、WASM。即 **Mac Intel 与 M 系列天然区分支持**，Windows arm64 也有官方覆盖——这是选它作统一运行时的决定性理由之一。
- 语言绑定：C++/C/Python/C#/Go/Kotlin/Java/JavaScript/Swift/Dart，Node 侧有官方 `sherpa-onnx-node` addon 与 WASM 包。

**「能否简单集成、不附带语音服务」结论**：
- ✅ **方案 A（推荐起步）：sherpa-onnx 单二进制 sidecar 子进程**。与现有 agent CLI 子进程管理同模式（spawn + stdio/WebSocket 喂 PCM、回文本），模型文件放 userData 按需下载。退出进程即释放全部资源，行为最可控。
- ⚠️ **方案 B：`sherpa-onnx-node` NAPI addon 进程内加载**。无子进程、调用最直接，但社区有 Electron 下加载失败的案例（2025-09 issue，ABI/签名相关），且 onnxruntime 的内存池释放后 RSS 未必完全归还 OS。若采用需 POC 验证；首期以 sidecar 为默认，addon 作为后续优化。
- ❌ 反例：FunASR websocket runtime（独立服务 + 1.5–2.5GB）、Python 服务、Docker —— 均属「附带语音模型服务」，排除。

## 6. 按需加载 / 卸载设计（补充 3）

**结论：可行，且 sidecar 模式可做到「不用时零占用」。**

模型生命周期 = sidecar 子进程生命周期：创建 recognizer（加载模型进内存）→ 会话 → 结束进程（内存全部归还 OS）。不存在 onnxruntime 内存池滞留问题。

**策略（写入正式 spec 时的验收点）**：

1. **懒加载**：用户首次按下麦克风才启动 sidecar 并加载当前选中模型；App 启动、页面加载均不预载。加载耗时预估数百 ms 至数秒（SenseVoice int8 偏快，Qwen3-ASR 偏慢），期间 UI 显示「语音引擎启动中」。
2. **单实例互斥**：同一时刻最多驻留一个模型实例。切换模型 = 结束旧 sidecar → 起新 sidecar 加载新模型；下载新模型不卸载当前可用模型（下载只是文件操作）。
3. **空闲自动卸载**：最后一次会话结束 T 分钟（默认 5，设置可调 0=会话结束立即卸载 / ∞=常驻）后自动退出 sidecar。有进行中会话时永不卸载。
4. **显式释放**：设置页显示「语音引擎当前占用（进程 RSS / 模型磁盘占用）」+「立即释放」按钮；模型管理支持删除已下载模型文件回收磁盘。
5. **模型文件按需分发**：安装包默认不打包语音模型（或仅打包一个最小默认模型，视安装包体积预算定），其余在设置页按 manifest 下载到 `userData/voice-models/`，带 sha256 校验与断点续传。
6. **进程看护**：sidecar 崩溃自动拉起（会话中断则当前会话报错，不做静默重试掩盖问题）。

**事件顺序（所有者：desktop Main）**：

```
[renderer] 按下麦克风
     │ IPC: voice:session:start
     ▼
[main] ensureModelLoaded(manifest)
     ├─ 模型文件缺失 → 下载（进度事件）→ 校验 sha256
     ├─ sidecar 未运行 → spawn + 握手 + 加载模型（状态事件）
     └─ 已加载 → 复用（重置 idle 计时器）
     ▼
[renderer] AudioWorklet 采集 16kHz mono PCM → IPC 分帧 feed
     ▼
[main→sidecar] PCM 流；sidecar 内置 VAD 分段
     ▼
[sidecar→main→renderer] partial（分段文本）/ final（整段精转）
     │ 用户松开 / 静音判定结束
     ▼
[main] finishSession → 返回最终文本 → 进入 idle 计时
     │ idle 超时 / 手动释放 / 切换模型
     ▼
[main] sidecar 进程退出，内存归零（状态事件同步 UI）
```

## 7. 多模型切换与通用抽象接口设计（补充 4）

**设计原则**（对齐仓库架构约束）：
- **Engine 与 Model 分离**：`engine` 是运行时实现（sherpa-onnx、whisper.cpp、远端 FunASR、系统 WebSpeech），`model` 是 engine 下可切换的模型清单（manifest）。
- **Main 是唯一 owner**：sidecar 生命周期、模型文件、会话状态全部归 desktop Main；Renderer 只做采集与展示；协议与类型进 `packages/shared`，通道登记进 `channels.ts`。
- **能力声明式 manifest**：UI 的模型选择器、下载提示、内存预估全部由 manifest 数据驱动，新增模型不改 UI 代码。

**接口草案（`packages/shared/src/voice.ts`）**：

```ts
export type VoiceEngineId = 'sherpa-onnx' | 'whisper-cpp' | 'funasr-remote' | 'webspeech';

export interface VoiceModelManifest {
  id: string;                      // 'sensevoice-int8-zh-en'
  engine: VoiceEngineId;
  modelType: string;               // engine 内部子类型：'sensevoice' | 'qwen3-asr' | 'zipformer-streaming' | ...
  label: string;                   // 展示名
  languages: Array<'zh' | 'en' | 'yue' | 'ja' | 'ko' | ...>;
  streaming: boolean;              // 是否真流式（决定 UI 是否实时上屏）
  approxDiskMb: number;            // 下载体积预估，UI 提示用
  approxRuntimeMemMb: [number, number];
  bundled: boolean;                // 安装包是否内置（默认 false）
  download?: { url: string; files: Array<{ path: string; sizeBytes: number; sha256: string }> };
  recommendedFor?: 'default' | 'low-end' | 'high-accuracy';
}

export interface VoiceModelState {
  modelId: string;
  installed: boolean;              // 文件已就位并通过校验
  loaded: boolean;                 // sidecar 正在运行且已加载
  downloading?: { receivedBytes: number; totalBytes: number };
  lastUsedAt?: number;
  processRssBytes?: number;        // 空闲卸载与「立即释放」按钮展示
}

export interface VoiceSessionOptions {
  modelId: string;
  language?: 'auto' | 'zh' | 'en';
  enablePartial?: boolean;         // 是否需要分段上屏
}

export interface VoiceSegment { text: string; startMs: number; endMs: number }
export interface VoiceFinalResult {
  sessionId: string;
  text: string;                    // 已去除情绪/事件标记、合并分段
  durationMs: number;
  segments: VoiceSegment[];
}

/** Main 进程实现；Renderer 经 IPC 调用（通道登记进 channels.ts） */
export interface IVoiceTranscriptionService {
  listModels(): Promise<VoiceModelManifest[]>;
  getModelState(modelId: string): Promise<VoiceModelState>;
  downloadModel(modelId: string): Promise<void>;          // 进度走事件
  deleteModel(modelId: string): Promise<void>;            // 回收磁盘
  startSession(opts: VoiceSessionOptions): Promise<{ sessionId: string }>;
  feedAudio(sessionId: string, pcm: Float32Array): void;  // 16kHz mono，分帧传输
  finishSession(sessionId: string): Promise<VoiceFinalResult>;
  cancelSession(sessionId: string): Promise<void>;
  unload(modelId?: string): Promise<void>;                // 缺省 = 卸载全部 sidecar
}
```

**IPC 通道与事件（登记进 `packages/shared/src/channels.ts`）**：
- 请求：`voice:model:list` / `voice:model:download` / `voice:model:delete` / `voice:session:start` / `voice:session:feed` / `voice:session:finish` / `voice:session:cancel` / `voice:engine:unload`
- 事件（Main → Renderer）：`voice:model:download-progress` / `voice:engine:state-changed`（loaded/unloaded/error + RSS）/ `voice:session:partial` / `voice:session:error`

**Renderer 侧**：`packages/ui/src/hooks/useVoiceInput.ts` 封装 `getUserMedia` + AudioWorklet（重采样 16k mono）+ 分帧 IPC + partial/final 订阅；composer 挂麦克风按钮与模型选择下拉（数据来自 `listModels()`，显示体积/内存预估/下载状态/当前占用）。UI 不接触 engine 细节。

**首期接入清单（满足「前期占用最小、快而准中英离线」）**：

| 优先级 | 模型 | 定位 | 磁盘 | 内存预估 |
|---|---|---|---|---|
| P0 默认 | SenseVoice-Small int8（sherpa-onnx） | 中英精准 + 极快 + 标点 | ~240MB | 0.5–1GB |
| P1 备选 | Zipformer 双语 streaming int8（sherpa-onnx） | 低配设备 / 真流式 | 80–250MB | 0.2–0.5GB |
| P2 可选下载 | Qwen3-ASR-0.6B int8（sherpa-onnx） | 高精度（Apache-2.0） | 0.7–1GB | 1.5–2.5GB |

**后续扩展位（同一接口，仅新增 engine/manifest）**：
- `whisper-cpp`：多语种兜底（英文强、许可 MIT），sidecar 二进制形态接入。
- `funasr-remote`：用户自建 FunASR 2-pass / OpenAI 兼容服务，manifest 填 URL，`feedAudio` 转发 websocket——服务端算力场景。
- `webspeech`：系统 `SpeechRecognition` 降级路径（非开源模型，仅作无法下载模型时的保底，明确标注隐私差异）。

**VAD 统一内置于 engine 层**（sherpa-onnx 自带 silero-vad / ten-vad），接口不暴露 VAD 细节；`streaming: false` 的模型由 engine 用「VAD 分段 + 离线识别」实现伪流式 partial。

## 8. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 桌面端整段转义：sidecar + SenseVoice int8 + 手动按住/松开 | 松开后 N 秒内出完整文本；空闲自动卸载后进程 RSS 归零 |
| P2 | VAD 伪流式上屏：partial 进输入框，松开以整段精转替换 | 边说边出字，分段延迟 ≤1s |
| P3 | LLM 整理管道（§9）+ 模型选择器 + Qwen3-ASR 可选下载 | 未配 KEY 走原文；配了 KEY 自动整理 |
| P4 | Web 端：renderer WASM（sherpa-onnx wasm + VAD demo 已有先例）或 `packages/server` 服务端 ASR | Web 会话框语音可用 |
| P5 | 手机远控：手机浏览器采集音频经现有 relay 送桌面 Host 跑同一 sidecar，文本回填 composer | 手机端语音输入不新增本地推理 |

每阶段先更新 `specs/desktop/voice-input.md`（状态所有者、协议、验收场景）再实现。

## 9. 转义整理 LLM 管道

- 触发：`VoiceFinalResult` 返回后，若设置中已配置「语音整理 API KEY」则自动调用；未配置则原文回填。
- 预处理：engine 层已剥离 SenseVoice 的情绪/事件标记（`<|laugh|>` 等），LLM 收到纯文本 + 分段时间戳（可选用于分段判断）。
- Prompt 要点：删除语气词（嗯/呃/那个/就是）、无意义停顿与叠词重复；恢复标点与分段；**不改原意、不润色、不翻译**（中英混说保持原文）；提供可选「轻度润色」开关作为用户选择项。
- 失败降级：LLM 调用失败/超时 → 回填原始转义文本 + toast 提示，不阻塞输入。

## 10. 风险与注意事项

1. **benchmark ≠ 真实**：AISHELL 类朗读语料与真实口语差距 3–7 倍。POC 必须用真实中英混说、带口音与语气词的语音实测 SenseVoice vs Qwen3-ASR 后再定默认模型。
2. **Qwen3-ASR 伪流式 bug**（官方 issue #129 无限重复）：实时上屏路径优先 SenseVoice；Qwen3-ASR 只用于「说完后整段精转」。
3. **`sherpa-onnx-node` 在 Electron 有加载失败案例**（2025-09，ABI/签名）：首期用 sidecar 规避；addon 留待 POC。
4. **onnxruntime 内存池**：进程内加载（addon/WASM）即使 dispose，RSS 可能不完全归还 OS；sidecar 模式天然规避——这是默认 sidecar 的核心理由。
5. **许可**：Qwen3-ASR Apache-2.0（最干净）；SenseVoice/Paraformer 权重走 FunASR License v1.1（商用可用，需署名/保留模型名，发布前过一遍条款并在关于页/NOTICE 声明）；sherpa-onnx Apache-2.0。
6. **体积预算**：默认不打包模型进安装包；三平台 × 双架构 sidecar 二进制约几十 MB/份，随安装包分发需评估体积影响。
7. **IPC 音频流吞吐**：16kHz mono Float32 ≈ 32KB/s，Int16 ≈ 16KB/s——量级很小，但需分帧（如 100ms/帧）避免 IPC 洪泛；跨架构矩阵（尤其 Windows arm64）纳入 P1 冒烟。

## 11. 参考来源

- sherpa-onnx：<https://github.com/k2-fsa/sherpa-onnx> · 预训练模型文档 <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html> · SenseVoice 章节（平台矩阵）<https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html> · NodeJS API <https://k2-fsa.github.io/sherpa/sherpa-onnx/nodejs/index.html> · npm <https://www.npmjs.com/package/sherpa-onnx>
- Qwen3-ASR：模型卡 <https://huggingface.co/Qwen/Qwen3-ASR-0.6B> · 开源公告 <https://qwen.ai/blog/id=qwen3asr> · sherpa-onnx int8 打包 <https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25>
- SenseVoice：<https://github.com/FunAudioLLM/SenseVoice>
- FunASR：<https://github.com/modelscope/FunASR> · 官网部署中心 <https://www.funasr.com/deploy> · 实时流式博客 <https://www.funasr.com/funasr-realtime-streaming-asr> · SDK 部署教程（并发基准）<https://gitee.com/funasr/docs/SDK_tutorial_online_zh>
- 深度对比（各家 CER 实测表）：<https://ruoqijin.com/blog/asr-deep-dive-2025-2026>
- Whisper 系：<https://github.com/ufal/whisper_streaming>（3.3s 流式延迟实测）· <https://huggingface.co/openai/whisper-large-v3-turbo>
- FireRedASR：<https://github.com/FireRedTeam/FireRedASR>
- 设备端 ASR 基准（2026-04，50+ 配置）：<https://arxiv.org>（Pushing the Limits of On-Device Streaming ASR）· Apple Silicon 端侧对比 <https://soniqo.audio>
- Qwen3-ASR ONNX CPU vs WebGPU 实测 issue：github.com（onnxruntime，2026-03）
- 2026 开源 STT 综述：<https://www.gladia.io> · <https://www.assemblyai.com> · <https://diyai.io>
