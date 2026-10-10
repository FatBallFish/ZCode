/**
 * Voice 引擎 worker 协议（desktop 包内部，非跨端协议）—— specs/desktop/voice-input.md §5.3。
 * main（VoiceService）与 utilityProcess（voiceEngineWorker）之间的消息契约；
 * 与 shared/voice.ts 的区分：这里只描述进程内实现细节（模型路径、采样计数）。
 */
import type { VoiceFinalResult, VoiceModelKind } from "@zcode/shared";

export interface VoiceEngineLoadMessage {
  type: "load";
  modelType: VoiceModelKind;
  /** 模型文件所在目录（含 tokens/分词器等全部文件）。 */
  modelDir: string;
  /** requiresVad 的模型必填：silero_vad.onnx 路径。 */
  vadModelPath?: string;
  numThreads: number;
}

export interface VoiceEngineFeedMessage {
  type: "feed";
  /** 会话序号（worker 单会话运行，reset 后递增；旧 feed 因序号不匹配丢弃）。 */
  seq: number;
  samples: Float32Array;
}

export interface VoiceEngineFinishMessage {
  type: "finish";
  seq: number;
}

export interface VoiceEngineResetMessage {
  type: "reset";
}

export interface VoiceEngineDisposeMessage {
  type: "dispose";
}

export type VoiceEngineCommand =
  | VoiceEngineLoadMessage
  | VoiceEngineFeedMessage
  | VoiceEngineFinishMessage
  | VoiceEngineResetMessage
  | VoiceEngineDisposeMessage;

export interface VoiceEngineLoadedMessage {
  type: "loaded";
  modelType: VoiceModelKind;
}

export interface VoiceEnginePartialMessage {
  type: "partial";
  seq: number;
  /** 累计文本（已完成段拼接 / 流式当前假设）。 */
  text: string;
}

export interface VoiceEngineFinalMessage {
  type: "final";
  seq: number;
  result: VoiceFinalResult;
}

export interface VoiceEngineErrorMessage {
  type: "error";
  message: string;
}

export type VoiceEngineEvent =
  | VoiceEngineLoadedMessage
  | VoiceEnginePartialMessage
  | VoiceEngineFinalMessage
  | VoiceEngineErrorMessage;
