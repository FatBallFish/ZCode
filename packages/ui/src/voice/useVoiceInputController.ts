/* eslint-disable max-lines -- 控制器是 renderer 侧采集/会话/整理/回填四段生命周期的单一所有者
   （specs/desktop/voice-input.md §4），拆分会把 latest ref 闭包共享的时序状态散射到多个模块。 */
/**
 * 语音输入控制器（App 级单例挂载）—— specs/desktop/voice-input.md §4 事件顺序。
 * 负责：麦克风采集（getUserMedia + AudioWorklet 16kHz mono Int16 分帧）、
 * 会话生命周期（start/feed/finish/cancel）、语义整理（workspace/generateText）、
 * 转录回填（window 事件 → 聚焦 composer）。
 */
import { useEffect, useRef } from "react";
import { DEFAULT_VOICE_MODEL_ID, type VoiceSessionStartResult } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  bindVoiceInputController,
  useVoiceInputStore,
  type VoiceInputPhase,
} from "@/voice/voiceInputStore.js";
import { dispatchVoiceTranscriptAppend } from "@/voice/voiceTranscript.js";

const TARGET_SAMPLE_RATE = 16_000;
/** 每帧 100ms（1600 samples）经 IPC 推送；16KB/s 量级不会淹没 IPC。 */
const FRAME_SAMPLES = TARGET_SAMPLE_RATE / 10;
const ERROR_AUTO_DISMISS_MS = 3_000;
const CLEANUP_TIMEOUT_MS = 60_000;

/** AudioWorklet 处理器：mono 混音 + 线性插值重采样到 16k，分帧输出 Int16。 */
const VOICE_PUMP_WORKLET_SOURCE = `
class VoicePumpProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this._step = sampleRate / this._targetRate;
    this._carry = new Float32Array(0);
    this._readPos = 0;
    this._out = [];
  }
  process(inputs) {
    const frames = inputs[0];
    if (!frames || frames.length === 0 || !frames[0]) return true;
    const ch0 = frames[0];
    const ch1 = frames[1];
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      mono[i] = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
    }
    const merged = new Float32Array(this._carry.length + mono.length);
    merged.set(this._carry, 0);
    merged.set(mono, this._carry.length);
    this._carry = merged;
    while (this._readPos + this._step < this._carry.length - 1) {
      const base = Math.floor(this._readPos);
      const frac = this._readPos - base;
      const sample = this._carry[base] * (1 - frac) + this._carry[base + 1] * frac;
      this._out.push(sample);
      this._readPos += this._step;
      if (this._out.length >= ${FRAME_SAMPLES}) {
        this._emit();
      }
    }
    const consumed = Math.floor(this._readPos);
    if (consumed > 0) {
      this._carry = this._carry.slice(consumed);
      this._readPos -= consumed;
    }
    return true;
  }
  _emit() {
    const frame = new Int16Array(${FRAME_SAMPLES});
    for (let i = 0; i < ${FRAME_SAMPLES}; i++) {
      const clamped = Math.max(-1, Math.min(1, this._out[i]));
      frame[i] = Math.round(clamped * 32767);
    }
    this._out.splice(0, ${FRAME_SAMPLES});
    this.port.postMessage(frame, [frame.buffer]);
  }
}
registerProcessor("voice-pump", VoicePumpProcessor);
`;

interface MicCapture {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
}

export interface VoiceInputControllerOptions {
  /** 取当前聚焦的本地 workspace；null = 无可用目标（远程 tab / 非 workspace tab）。 */
  resolveActiveWorkspace: () => { workspacePath: string } | null;
}

export function useVoiceInputController(options: VoiceInputControllerOptions): void {
  const platform = usePlatform();
  const services = useServices();
  const { settings } = useSettings();
  const { intl } = useZCodeIntl();

  const latest = useRef({
    platform,
    services,
    settings,
    intl,
    resolveActiveWorkspace: options.resolveActiveWorkspace,
  });
  latest.current = {
    platform,
    services,
    settings,
    intl,
    resolveActiveWorkspace: options.resolveActiveWorkspace,
  };

  const micRef = useRef<MicCapture | null>(null);
  const sessionRef = useRef<{ sessionId: string; modelId: string } | null>(null);
  const phaseRef = useRef<VoiceInputPhase>("idle");
  const errorDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhase = (phase: VoiceInputPhase) => {
    phaseRef.current = phase;
    useVoiceInputStore.setState({ phase });
  };

  const failWith = (key: string, detail?: string) => {
    if (errorDismissTimerRef.current) clearTimeout(errorDismissTimerRef.current);
    useVoiceInputStore.setState({ error: { key, ...(detail ? { detail } : {}) } });
    setPhase("error");
    errorDismissTimerRef.current = setTimeout(() => {
      if (phaseRef.current === "error") {
        resetToIdle();
      }
    }, ERROR_AUTO_DISMISS_MS);
  };

  const resetToIdle = () => {
    sessionRef.current = null;
    useVoiceInputStore.setState({
      phase: "idle",
      sessionId: null,
      modelId: null,
      partialText: "",
      downloadProgress: null,
      engineLoading: false,
      finishingStage: null,
      error: null,
    });
    phaseRef.current = "idle";
  };

  const stopMic = () => {
    const mic = micRef.current;
    micRef.current = null;
    if (!mic) return;
    try {
      mic.node.port.onmessage = null;
      mic.source.disconnect();
      mic.node.disconnect();
      mic.sink.disconnect();
      for (const track of mic.stream.getTracks()) track.stop();
      void mic.context.close().catch(() => undefined);
    } catch (error) {
      logger.warn("voice mic teardown error", { error: String(error) });
    }
  };

  const setupMic = async (onFrame: (frame: Int16Array) => void): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    let context: AudioContext;
    try {
      // Chromium 支持任意采样率 AudioContext，直接让管线重采样到 16k。
      context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      context = new AudioContext();
    }
    const blobUrl = URL.createObjectURL(
      new Blob([VOICE_PUMP_WORKLET_SOURCE], { type: "text/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "voice-pump", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { targetRate: TARGET_SAMPLE_RATE },
    });
    // 静音汇点维持音频图运转（worklet 输出不外放）。
    const sink = context.createGain();
    sink.gain.value = 0;
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data instanceof Int16Array) onFrame(event.data);
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
    micRef.current = { context, stream, source, node, sink };
  };

  const runCleanup = async (transcript: string): Promise<string> => {
    const { services: currentServices, intl: currentIntl } = latest.current;
    const selection = latest.current.settings?.voiceCleanupSelection;
    const workspace = latest.current.resolveActiveWorkspace();
    if (!selection || !workspace) return transcript;
    const systemPrompt = currentIntl.formatMessage({ id: "voice.cleanup.systemPrompt" });
    const userPrompt = currentIntl.formatMessage(
      { id: "voice.cleanup.userPrompt" },
      { transcript },
    );
    try {
      const result = await currentServices.zcodeAgentService.generateWorkspaceText({
        workspacePath: workspace.workspacePath,
        selection: { providerId: selection.providerId, modelId: selection.modelId },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        querySource: "voice-cleanup",
        maxOutputTokens: 2048,
        requestTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      const text = result.text.trim();
      if (text.length === 0) return transcript;
      return text;
    } catch (error) {
      // 整理失败降级为原始转录（specs §3.3：不阻塞回填）。
      logger.warn("voice cleanup failed; falling back to raw transcript", {
        error: String(error),
      });
      return transcript;
    }
  };

  const begin = async () => {
    if (phaseRef.current !== "idle") return;
    // 防御：上一生命周期若异常残留采集（理论上不该发生），先关掉再开新的。
    stopMic();
    const { platform: currentPlatform } = latest.current;
    if (!currentPlatform.voiceStartSession || !currentPlatform.voiceFeedAudio) {
      failWith("voice.error.unsupported");
      return;
    }
    const workspace = latest.current.resolveActiveWorkspace();
    if (!workspace) {
      failWith("voice.error.noWorkspace");
      return;
    }
    const modelId = latest.current.settings?.voiceInputModelId ?? DEFAULT_VOICE_MODEL_ID;
    useVoiceInputStore.setState({
      phase: "preparing",
      sessionId: null,
      modelId,
      partialText: "",
      downloadProgress: null,
      engineLoading: true,
      finishingStage: null,
      error: null,
    });
    phaseRef.current = "preparing";

    // 麦克风授权与引擎准备并行（下载/加载可能耗时数十秒，授权弹窗同时出现）。
    const micPromise = setupMic((frame) => {
      const session = sessionRef.current;
      if (session) latest.current.platform.voiceFeedAudio?.(session.sessionId, frame);
    }).catch((error: Error) => error);

    const sessionResult: VoiceSessionStartResult = await currentPlatform
      .voiceStartSession(modelId)
      .catch(
        (error: Error): VoiceSessionStartResult => ({
          ok: false,
          error: "engine-error",
          message: error.message,
        }),
      );

    if (!sessionResult.ok) {
      // 麦克风可能仍在授权/启动中：等它落定后立即关闭，否则系统麦克风指示灯常开。
      const micError = await Promise.resolve(micPromise);
      void micError;
      stopMic();
      const keyByError: Record<string, string> = {
        busy: "voice.error.busy",
        "model-not-found": "voice.error.engine",
        "download-failed": "voice.error.download",
        "arch-unsupported": "voice.error.arch",
        "engine-error": "voice.error.engine",
      };
      failWith(keyByError[sessionResult.error] ?? "voice.error.engine", sessionResult.message);
      return;
    }

    const micResult = await micPromise;
    if (micResult instanceof Error) {
      currentPlatform.voiceCancelSession?.(sessionResult.sessionId).catch(() => undefined);
      const notAllowed = micResult.name === "NotAllowedError" || micResult.name === "SecurityError";
      failWith(
        notAllowed ? "voice.error.micDenied" : "voice.error.micUnavailable",
        micResult.message,
      );
      return;
    }

    sessionRef.current = { sessionId: sessionResult.sessionId, modelId: sessionResult.modelId };
    useVoiceInputStore.setState({
      sessionId: sessionResult.sessionId,
      modelId: sessionResult.modelId,
      engineLoading: false,
    });
    // listening 状态以 main 的 session 事件为准；此处兜底（事件竞态时直接进入）。
    if (phaseRef.current === "preparing") {
      useVoiceInputStore.setState({ partialText: "" });
      setPhase("listening");
    }
  };

  const finish = async () => {
    const session = sessionRef.current;
    if (!session) {
      resetToIdle();
      return;
    }
    // 先停麦再 finish：worker 侧已缓冲的音频足够完成尾段识别。
    stopMic();
    setPhase("finishing");
    useVoiceInputStore.setState({ finishingStage: "transcribing" });

    const result = await latest.current.platform
      .voiceFinishSession?.(session.sessionId)
      .catch((error: Error): { ok: false; error: string } => ({
        ok: false,
        error: error.message,
      }));

    if (!result || !result.ok) {
      failWith("voice.error.engine", result && !result.ok ? result.error : undefined);
      sessionRef.current = null;
      return;
    }
    sessionRef.current = null;

    const transcript = result.result.text.trim();
    if (transcript.length === 0) {
      failWith("voice.emptyResult");
      return;
    }

    const cleanupEnabled =
      latest.current.settings?.voiceCleanupEnabled === true &&
      Boolean(latest.current.settings?.voiceCleanupSelection);
    let finalText = transcript;
    if (cleanupEnabled) {
      useVoiceInputStore.setState({ finishingStage: "cleanup" });
      finalText = await runCleanup(transcript);
    }
    dispatchVoiceTranscriptAppend(finalText);
    resetToIdle();
  };

  const cancel = () => {
    const session = sessionRef.current;
    stopMic();
    if (session) {
      latest.current.platform.voiceCancelSession?.(session.sessionId).catch(() => undefined);
    }
    resetToIdle();
  };

  // ── 事件订阅 ──
  useEffect(() => {
    const disposeState = platform.onVoiceStateChanged?.((snapshot) => {
      const state = useVoiceInputStore.getState();
      if (state.modelId) {
        const model = snapshot.models.find((entry) => entry.modelId === state.modelId);
        if (model && model.install.status === "downloading") {
          useVoiceInputStore.setState({
            downloadProgress: {
              receivedBytes: model.install.receivedBytes,
              totalBytes: model.install.totalBytes,
              activeFile: model.install.activeFile,
            },
          });
        } else {
          useVoiceInputStore.setState({ downloadProgress: null });
        }
      }
    });
    const disposeSession = platform.onVoiceSessionEvent?.(({ sessionId, event }) => {
      const state = useVoiceInputStore.getState();
      // engine-loading 事件在 sessionId 分配前发出（空 id），直接消费。
      if (sessionId && state.sessionId && sessionId !== state.sessionId) return;
      if (event.kind === "engine-loading") {
        // engine-loading 在 sessionId 分配前发出（空 id）；仅本控制器发起的 preparing 阶段消费，
        // 避免 main 广播误置其他窗口/空闲态的 engineLoading。
        if (phaseRef.current === "preparing" && state.modelId === event.modelId) {
          useVoiceInputStore.setState({ engineLoading: true });
        }
      } else if (event.kind === "listening") {
        if (phaseRef.current === "preparing" || phaseRef.current === "listening") {
          useVoiceInputStore.setState({ engineLoading: false });
          setPhase("listening");
        }
      } else if (event.kind === "partial") {
        if (phaseRef.current === "listening") {
          useVoiceInputStore.setState({ partialText: event.text });
        }
      } else if (event.kind === "error") {
        if (phaseRef.current === "preparing" || phaseRef.current === "listening") {
          const session = sessionRef.current;
          stopMic();
          sessionRef.current = null;
          // main 侧引擎错误会自清理会话；这里补发 cancel 兜底旧版本/竞态残留。
          if (session) {
            latest.current.platform.voiceCancelSession?.(session.sessionId).catch(() => undefined);
          }
          failWith("voice.error.engine", event.message);
        }
      }
    });
    return () => {
      disposeState?.();
      disposeSession?.();
    };
  }, [platform]);

  // ── controller 绑定（组件卸载时解绑并收敛在途会话）──
  useEffect(() => {
    bindVoiceInputController({
      toggle: () => {
        const phase = phaseRef.current;
        if (phase === "idle") {
          void begin();
        } else if (phase === "listening") {
          void finish();
        } else if (phase === "preparing") {
          cancel();
        }
        // finishing/error：不可取消（秒级），error 自动消隐。
      },
      cancel: () => {
        const phase = phaseRef.current;
        if (phase === "preparing" || phase === "listening") {
          cancel();
        }
      },
    });
    return () => {
      bindVoiceInputController(null);
      if (errorDismissTimerRef.current) clearTimeout(errorDismissTimerRef.current);
      cancel();
    };
    // begin/finish/cancel 均经 latest ref 取依赖，绑定只做一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
