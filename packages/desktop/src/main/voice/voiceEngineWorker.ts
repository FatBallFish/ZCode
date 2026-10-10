/**
 * 语音识别引擎 worker —— specs/desktop/voice-input.md §5.3。
 * 以 Electron utilityProcess 运行（CJS，sherpa-onnx-node 保持 external 的原生依赖），
 * 进程退出即释放全部模型内存（VoiceService 空闲卸载的实现基础）。
 *
 * 会话模型：worker 单会话运行；`seq` 由 reset 递增，旧 feed/finish 因序号不匹配丢弃，
 * 与 main 侧 sessionId 校验构成双保险（main 是会话唯一所有者）。
 */
import { join } from "node:path";
import sherpaOnnxNode from "sherpa-onnx-node";
import type {
  SherpaOfflineRecognizer,
  SherpaOnlineRecognizer,
  SherpaOnlineStream,
  SherpaVad,
} from "sherpa-onnx-node";
import type { VoiceModelKind } from "@zcode/shared";
import type { VoiceEngineCommand, VoiceEngineEvent } from "./voiceEngineProtocol.js";

const SAMPLE_RATE = 16_000;

interface OfflineSegmentRecord {
  text: string;
  startMs: number;
  endMs: number;
}

interface OfflineSessionState {
  segments: OfflineSegmentRecord[];
  totalSamples: number;
}

let loadedModelType: VoiceModelKind | null = null;
let offlineRecognizer: SherpaOfflineRecognizer | null = null;
let onlineRecognizer: SherpaOnlineRecognizer | null = null;
let onlineStream: SherpaOnlineStream | null = null;
let vad: SherpaVad | null = null;

let seq = 0;
let offlineSession: OfflineSessionState = { segments: [], totalSamples: 0 };
/** 流式 partial 文本的空格衔接由 getResult 内部维护，无需额外状态。 */

function post(event: VoiceEngineEvent): void {
  process.parentPort?.postMessage(event);
}

function fail(message: string): void {
  post({ type: "error", message });
}

/** 剥离 SenseVoice 情绪/事件标记（<|laugh|> 等），并把全大写英文归一为小写。
 * SenseVoice 英文输出恒为全大写；仅在文本以拉丁大写为主时逐词（≥2 字母）小写，
 * 避免误伤正常大小写混排与其他模型输出。 */
function normalizeTranscriptText(raw: string): string {
  let text = raw.replace(/<\|[^|>]*\|>/g, "");
  const latinLetters = text.replace(/[^A-Za-z]/g, "");
  if (latinLetters.length >= 8) {
    const upperLetters = latinLetters.replace(/[^A-Z]/g, "").length;
    if (upperLetters / latinLetters.length > 0.7) {
      text = text.replace(/[A-Z]{2,}/g, (word) => word.toLowerCase());
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function buildOfflineRecognizer(
  modelType: "sensevoice" | "qwen3-asr",
  modelDir: string,
  numThreads: number,
): SherpaOfflineRecognizer {
  const sharedModelConfig = {
    numThreads,
    debug: 0 as const,
    provider: "cpu",
  };
  if (modelType === "sensevoice") {
    return new sherpaOnnxNode.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        ...sharedModelConfig,
        senseVoice: {
          model: join(modelDir, "model.int8.onnx"),
          language: "",
          useInverseTextNormalization: 1,
        },
        tokens: join(modelDir, "tokens.txt"),
      },
    });
  }
  return new sherpaOnnxNode.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
    modelConfig: {
      ...sharedModelConfig,
      qwen3Asr: {
        encoder: join(modelDir, "encoder.int8.onnx"),
        decoder: join(modelDir, "decoder.int8.onnx"),
        convFrontend: join(modelDir, "conv_frontend.onnx"),
        tokenizer: join(modelDir, "tokenizer"),
      },
    },
  });
}

function recognizeOfflineSamples(samples: Float32Array): string {
  if (!offlineRecognizer) return "";
  const stream = offlineRecognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  offlineRecognizer.decode(stream);
  return normalizeTranscriptText(offlineRecognizer.getResult(stream).text);
}

function drainVadSegments(state: OfflineSessionState): OfflineSegmentRecord[] {
  const recognized: OfflineSegmentRecord[] = [];
  while (vad && !vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    const text = recognizeOfflineSamples(segment.samples);
    if (text.length > 0) {
      recognized.push({
        text,
        startMs: Math.round((segment.start / SAMPLE_RATE) * 1000),
        endMs: Math.round(((segment.start + segment.samples.length) / SAMPLE_RATE) * 1000),
      });
    }
  }
  state.segments.push(...recognized);
  return recognized;
}

function handleOfflineFeed(samples: Float32Array): void {
  if (!offlineSession) return;
  offlineSession.totalSamples += samples.length;
  if (vad) {
    // silero VAD 内部按 windowSize(512) 步进；一次喂入分多窗处理，segment 就绪即出。
    vad.acceptWaveform(samples);
    drainVadSegments(offlineSession);
  } else {
    // 无 VAD 兜底：整段缓冲，finish 时一次性识别（不应发生：requiresVad 模型加载时已校验）。
    const text = recognizeOfflineSamples(samples);
    if (text.length > 0) {
      offlineSession.segments.push({
        text,
        startMs: 0,
        endMs: Math.round((offlineSession.totalSamples / SAMPLE_RATE) * 1000),
      });
    }
  }
  post({
    type: "partial",
    seq,
    text: offlineSession.segments.map((segment) => segment.text).join(""),
  });
}

function handleOfflineFinish(): void {
  if (!offlineSession) return;
  if (vad) {
    vad.flush();
    drainVadSegments(offlineSession);
  }
  const text = offlineSession.segments.map((segment) => segment.text).join("");
  post({
    type: "final",
    seq,
    result: {
      text,
      durationMs: Math.round((offlineSession.totalSamples / SAMPLE_RATE) * 1000),
      segments: offlineSession.segments,
    },
  });
}

function handleOnlineFeed(samples: Float32Array): void {
  if (!onlineRecognizer || !onlineStream) return;
  onlineStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  while (onlineRecognizer.isReady(onlineStream)) {
    onlineRecognizer.decode(onlineStream);
  }
  post({
    type: "partial",
    seq,
    text: normalizeTranscriptText(onlineRecognizer.getResult(onlineStream).text),
  });
}

function handleOnlineFinish(): void {
  if (!onlineRecognizer || !onlineStream) return;
  while (onlineRecognizer.isReady(onlineStream)) {
    onlineRecognizer.decode(onlineStream);
  }
  const text = normalizeTranscriptText(onlineRecognizer.getResult(onlineStream).text);
  post({
    type: "final",
    seq,
    result: {
      text,
      durationMs: 0,
      segments: text.length > 0 ? [{ text, startMs: 0, endMs: 0 }] : [],
    },
  });
}

function resetSession(): void {
  seq += 1;
  offlineSession = { segments: [], totalSamples: 0 };
  if (vad) {
    vad.reset();
    vad.clear();
  }
  if (onlineRecognizer) {
    onlineStream = onlineRecognizer.createStream();
  }
}

function handleCommand(command: VoiceEngineCommand): void {
  try {
    switch (command.type) {
      case "load": {
        if (command.modelType === "zipformer-streaming") {
          onlineRecognizer = new sherpaOnnxNode.OnlineRecognizer({
            featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
            modelConfig: {
              transducer: {
                encoder: join(command.modelDir, "encoder.int8.onnx"),
                decoder: join(command.modelDir, "decoder.int8.onnx"),
                joiner: join(command.modelDir, "joiner.int8.onnx"),
              },
              tokens: join(command.modelDir, "tokens.txt"),
              numThreads: command.numThreads,
              debug: 0,
              provider: "cpu",
            },
          });
          onlineStream = onlineRecognizer.createStream();
          vad = null;
          offlineRecognizer = null;
        } else {
          offlineRecognizer = buildOfflineRecognizer(
            command.modelType,
            command.modelDir,
            command.numThreads,
          );
          onlineRecognizer = null;
          onlineStream = null;
          if (command.vadModelPath) {
            vad = new sherpaOnnxNode.Vad(
              {
                sileroVad: {
                  model: command.vadModelPath,
                  threshold: 0.5,
                  minSilenceDuration: 0.5,
                  minSpeechDuration: 0.25,
                  windowSize: 512,
                  maxSpeechDuration: 20,
                },
                sampleRate: SAMPLE_RATE,
                numThreads: 1,
                provider: "cpu",
                debug: 0,
              },
              120,
            );
          } else {
            vad = null;
          }
        }
        loadedModelType = command.modelType;
        resetSession();
        post({ type: "loaded", modelType: command.modelType });
        return;
      }
      case "feed": {
        if (command.seq !== seq) return;
        if (loadedModelType === "zipformer-streaming") {
          handleOnlineFeed(command.samples);
        } else {
          handleOfflineFeed(command.samples);
        }
        return;
      }
      case "finish": {
        if (command.seq !== seq) return;
        if (loadedModelType === "zipformer-streaming") {
          handleOnlineFinish();
        } else {
          handleOfflineFinish();
        }
        return;
      }
      case "reset": {
        resetSession();
        return;
      }
      case "dispose": {
        loadedModelType = null;
        offlineRecognizer = null;
        onlineRecognizer = null;
        onlineStream = null;
        vad = null;
        offlineSession = { segments: [], totalSamples: 0 };
        return;
      }
    }
  } catch (error) {
    fail(`voice engine worker error: ${(error as Error)?.message ?? String(error)}`);
  }
}

process.parentPort?.on("message", (event: { data?: unknown }) => {
  handleCommand(event.data as VoiceEngineCommand);
});
