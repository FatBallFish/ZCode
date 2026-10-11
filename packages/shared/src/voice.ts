import { z } from "zod";

/**
 * 会话语音输入：本地 ASR（sherpa-onnx）协议与模型清单 —— specs/desktop/voice-input.md。
 *
 * 设计约束：
 * - 本文件只含纯数据 + 纯类型/校验，供 desktop main / renderer / 设置页共用；
 * - 模型清单是唯一事实来源：设置页展示、下载校验、引擎加载全部由 manifest 驱动；
 * - 音频统一 16kHz mono；renderer 采 Int16 传输（IPC 体积减半），main 侧转 Float32。
 */

/** 引擎子类型：worker 内按此分支构建 recognizer。 */
export type VoiceModelKind = "sensevoice" | "zipformer-streaming" | "qwen3-asr";

/** 单个模型文件（相对模型目录的路径 + 下载源与校验值）。 */
export interface VoiceModelFile {
  /** 相对 `voice-models/<modelId>/` 的路径（可含子目录，如 tokenizer/vocab.json）。 */
  readonly path: string;
  readonly url: string;
  /** 镜像源（HF 直连不可达时回退，如 hf-mirror.com）。 */
  readonly mirrorUrl?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface VoiceModelManifest {
  readonly id: string;
  readonly kind: VoiceModelKind;
  /** i18n 展示名（settings.voiceInput.model.<id>.name）。 */
  readonly labelKey: string;
  readonly languages: readonly string[];
  /** 是否真流式（连续 partial）；false = VAD 分段伪流式。 */
  readonly streaming: boolean;
  /** 输出自带标点（sensevoice ITN / qwen3）。 */
  readonly punctuated: boolean;
  readonly approxDiskMb: number;
  readonly approxRuntimeMemMb: readonly [number, number];
  readonly recommendedFor: "default" | "low-end" | "high-accuracy";
  /** 离线模型需要 silero VAD 配合分段。 */
  readonly requiresVad: boolean;
  readonly files: readonly VoiceModelFile[];
}

const voiceModelFileSchema = z.object({
  path: z.string().trim().min(1),
  url: z.string().url(),
  mirrorUrl: z.string().url().optional(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const voiceModelManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  kind: z.enum(["sensevoice", "zipformer-streaming", "qwen3-asr"]),
  labelKey: z.string().min(1),
  languages: z.array(z.string()).min(1),
  streaming: z.boolean(),
  punctuated: z.boolean(),
  approxDiskMb: z.number().positive(),
  approxRuntimeMemMb: z.tuple([z.number().positive(), z.number().positive()]),
  recommendedFor: z.enum(["default", "low-end", "high-accuracy"]),
  requiresVad: z.boolean(),
  files: z.array(voiceModelFileSchema).min(1),
});

/** VAD 是共享依赖，独立于具体模型存放在 `voice-models/_vad/`。 */
export const VOICE_VAD_ARTIFACT: VoiceModelFile = {
  path: "silero_vad.onnx",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  mirrorUrl: "https://hf-mirror.com/csukuangfj/sherpa-onnx-silero-vad/resolve/main/silero_vad.onnx",
  sizeBytes: 643_854,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
};

const SENSEVOICE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09";
const SENSEVOICE_URL = `https://huggingface.co/${SENSEVOICE_REPO}/resolve/main`;
const SENSEVOICE_MIRROR = `https://hf-mirror.com/${SENSEVOICE_REPO}/resolve/main`;

const ZIPFORMER_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
const ZIPFORMER_URL = `https://huggingface.co/${ZIPFORMER_REPO}/resolve/main`;
const ZIPFORMER_MIRROR = `https://hf-mirror.com/${ZIPFORMER_REPO}/resolve/main`;

const QWEN3_REPO = "csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25";
const QWEN3_URL = `https://huggingface.co/${QWEN3_REPO}/resolve/main`;
const QWEN3_MIRROR = `https://hf-mirror.com/${QWEN3_REPO}/resolve/main`;

/** 内置语音模型清单（文件按需下载，安装包不打包模型）。 */
export const VOICE_MODEL_MANIFESTS: readonly VoiceModelManifest[] = [
  {
    id: "sensevoice-int8",
    kind: "sensevoice",
    labelKey: "settings.voiceInput.model.sensevoice-int8.name",
    languages: ["zh", "en", "ja", "ko", "yue"],
    streaming: false,
    punctuated: true,
    approxDiskMb: 227,
    approxRuntimeMemMb: [512, 1024],
    recommendedFor: "default",
    requiresVad: true,
    files: [
      {
        path: "model.int8.onnx",
        url: `${SENSEVOICE_URL}/model.int8.onnx`,
        mirrorUrl: `${SENSEVOICE_MIRROR}/model.int8.onnx`,
        sizeBytes: 237_115_547,
        sha256: "12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d",
      },
      {
        path: "tokens.txt",
        url: `${SENSEVOICE_URL}/tokens.txt`,
        mirrorUrl: `${SENSEVOICE_MIRROR}/tokens.txt`,
        sizeBytes: 315_894,
        sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
      },
    ],
  },
  {
    id: "zipformer-bilingual-int8",
    kind: "zipformer-streaming",
    labelKey: "settings.voiceInput.model.zipformer-bilingual-int8.name",
    languages: ["zh", "en"],
    streaming: true,
    punctuated: false,
    approxDiskMb: 189,
    approxRuntimeMemMb: [256, 512],
    recommendedFor: "low-end",
    requiresVad: false,
    files: [
      {
        path: "encoder.int8.onnx",
        url: `${ZIPFORMER_URL}/encoder-epoch-99-avg-1.int8.onnx`,
        mirrorUrl: `${ZIPFORMER_MIRROR}/encoder-epoch-99-avg-1.int8.onnx`,
        sizeBytes: 181_895_032,
        sha256: "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
      },
      {
        path: "decoder.int8.onnx",
        url: `${ZIPFORMER_URL}/decoder-epoch-99-avg-1.int8.onnx`,
        mirrorUrl: `${ZIPFORMER_MIRROR}/decoder-epoch-99-avg-1.int8.onnx`,
        sizeBytes: 13_091_040,
        sha256: "1a70c593d71e53f023f5f55b0b4cfff5055abb786ee3992e5f63dc2e273cc4fa",
      },
      {
        path: "joiner.int8.onnx",
        url: `${ZIPFORMER_URL}/joiner-epoch-99-avg-1.int8.onnx`,
        mirrorUrl: `${ZIPFORMER_MIRROR}/joiner-epoch-99-avg-1.int8.onnx`,
        sizeBytes: 3_228_404,
        sha256: "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
      },
      {
        path: "tokens.txt",
        url: `${ZIPFORMER_URL}/tokens.txt`,
        mirrorUrl: `${ZIPFORMER_MIRROR}/tokens.txt`,
        sizeBytes: 56_317,
        sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
      },
    ],
  },
  {
    id: "qwen3-asr-0.6b-int8",
    kind: "qwen3-asr",
    labelKey: "settings.voiceInput.model.qwen3-asr-0.6b-int8.name",
    languages: ["zh", "en", "yue", "multi"],
    streaming: false,
    punctuated: true,
    approxDiskMb: 940,
    approxRuntimeMemMb: [1536, 2560],
    recommendedFor: "high-accuracy",
    requiresVad: true,
    files: [
      {
        path: "encoder.int8.onnx",
        url: `${QWEN3_URL}/encoder.int8.onnx`,
        mirrorUrl: `${QWEN3_MIRROR}/encoder.int8.onnx`,
        sizeBytes: 182_491_662,
        sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
      },
      {
        path: "decoder.int8.onnx",
        url: `${QWEN3_URL}/decoder.int8.onnx`,
        mirrorUrl: `${QWEN3_MIRROR}/decoder.int8.onnx`,
        sizeBytes: 755_914_231,
        sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf4d5e76eab6d8b61ca5771",
      },
      {
        path: "conv_frontend.onnx",
        url: `${QWEN3_URL}/conv_frontend.onnx`,
        mirrorUrl: `${QWEN3_MIRROR}/conv_frontend.onnx`,
        sizeBytes: 44_148_281,
        sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
      },
      {
        path: "tokenizer/vocab.json",
        url: `${QWEN3_URL}/tokenizer/vocab.json`,
        mirrorUrl: `${QWEN3_MIRROR}/tokenizer/vocab.json`,
        sizeBytes: 2_776_833,
        sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
      },
      {
        path: "tokenizer/merges.txt",
        url: `${QWEN3_URL}/tokenizer/merges.txt`,
        mirrorUrl: `${QWEN3_MIRROR}/tokenizer/merges.txt`,
        sizeBytes: 1_671_853,
        sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
      },
      {
        path: "tokenizer/tokenizer_config.json",
        url: `${QWEN3_URL}/tokenizer/tokenizer_config.json`,
        mirrorUrl: `${QWEN3_MIRROR}/tokenizer/tokenizer_config.json`,
        sizeBytes: 12_487,
        sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
      },
    ],
  },
];

export const DEFAULT_VOICE_MODEL_ID = "sensevoice-int8";

export function findVoiceModelManifest(modelId: string): VoiceModelManifest | undefined {
  return VOICE_MODEL_MANIFESTS.find((manifest) => manifest.id === modelId);
}

/** 会话结束后的空闲卸载延迟（specs §6）。 */
export const VOICE_ENGINE_IDLE_UNLOAD_MS = 5 * 60_000;

// ── 模型/引擎状态（main 为唯一所有者，renderer 只读） ──

export type VoiceModelInstallState =
  | { status: "not-installed" }
  | { status: "downloading"; receivedBytes: number; totalBytes: number; activeFile: string }
  | { status: "installed" }
  | { status: "error"; message: string };

export const voiceModelInstallStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-installed") }),
  z.object({
    status: z.literal("downloading"),
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive(),
    activeFile: z.string(),
  }),
  z.object({ status: z.literal("installed") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export interface VoiceStateSnapshot {
  /** 平台是否支持（win-arm64 无 sherpa-onnx 预编译包）。 */
  supported: boolean;
  unsupportedReason?: string;
  models: ReadonlyArray<{ modelId: string; install: VoiceModelInstallState; lastUsedAt?: number }>;
  vadInstalled: boolean;
  /** 当前引擎已加载的模型 id；null = 未加载（空闲卸载后）。 */
  loadedModelId: string | null;
  activeSession: { sessionId: string; modelId: string; startedAt: number } | null;
}

export const voiceStateSnapshotSchema = z.object({
  supported: z.boolean(),
  unsupportedReason: z.string().optional(),
  models: z.array(
    z.object({
      modelId: z.string(),
      install: voiceModelInstallStateSchema,
      lastUsedAt: z.number().optional(),
    }),
  ),
  vadInstalled: z.boolean(),
  loadedModelId: z.string().nullable(),
  activeSession: z
    .object({ sessionId: z.string(), modelId: z.string(), startedAt: z.number() })
    .nullable(),
});

// ── 会话 ──

export type VoiceSessionStartError =
  | "busy"
  | "model-not-found"
  | "download-failed"
  | "arch-unsupported"
  | "engine-error";

export type VoiceSessionStartResult =
  | { ok: true; sessionId: string; modelId: string }
  | { ok: false; error: VoiceSessionStartError; message?: string };

/** 引擎就绪后开始推流前，main → renderer 的会话内事件。 */
export type VoiceSessionEvent =
  | { kind: "engine-loading"; modelId: string }
  | { kind: "listening"; modelId: string }
  /** 累计识别文本（伪流式为已完成段拼接，真流式为当前假设文本）。 */
  | { kind: "partial"; text: string }
  | { kind: "error"; message: string };

export interface VoiceSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceFinalResult {
  /** 已剥离情绪/事件标记、合并分段的完整文本。 */
  text: string;
  durationMs: number;
  segments: VoiceSegment[];
}

// ── 语义整理模型选择（AppSettings 持久化，同 modelSelectionSchema 形状） ──

export const voiceCleanupSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    /** 要求思考档位的模型（GLM 系 coding plan）必须携带，运行时映射为 options.reasoningLevel。 */
    reasoningLevel: z.string().trim().min(1).optional(),
  })
  .strict();

export type VoiceCleanupSelection = z.infer<typeof voiceCleanupSelectionSchema>;

// ── 麦克风权限（specs/desktop/voice-input.md §3.5）──

/**
 * `unsupported`：平台无 TCC 式预检（Windows/Linux，授权交给 getUserMedia 的系统提示）。
 * 其余值对应 macOS `systemPreferences.getMediaAccessStatus("microphone")`。
 */
export type VoiceMicPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unsupported";

export interface VoiceMicPermissionResult {
  status: VoiceMicPermissionStatus;
}

export const voiceMicPermissionResultSchema = z.object({
  status: z.enum(["granted", "denied", "not-determined", "restricted", "unsupported"]),
});
