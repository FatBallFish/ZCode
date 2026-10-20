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
/** 语义整理默认最大输出 Token（2026-10-14 调参值）；分组覆盖存在时被覆盖（specs/provider/group-token-override.md）。 */
const VOICE_CLEANUP_MAX_OUTPUT_TOKENS = 16_384;

/** AudioWorklet 处理器：mono 混音 + 线性插值重采样到 16k，分帧输出 Int16。
 * 每帧附带 RMS 电平（音浪动画）；支持 flush 消息把重采样累加器里的尾帧
 * （<100ms）补发出来——否则用户停止录音瞬间说的最后半句会被整帧丢弃。 */
const VOICE_PUMP_WORKLET_SOURCE = `
class VoicePumpProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this._step = sampleRate / this._targetRate;
    this._carry = new Float32Array(0);
    this._readPos = 0;
    this._out = [];
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === "flush") {
        this._emit(this._out.length);
        this.port.postMessage({ type: "flushed" });
      }
    };
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
        this._emit(${FRAME_SAMPLES});
      }
    }
    const consumed = Math.floor(this._readPos);
    if (consumed > 0) {
      this._carry = this._carry.slice(consumed);
      this._readPos -= consumed;
    }
    return true;
  }
  _emit(count) {
    if (!(count > 0) || this._out.length < count) return;
    const frame = new Int16Array(count);
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      const clamped = Math.max(-1, Math.min(1, this._out[i]));
      frame[i] = Math.round(clamped * 32767);
      sumSquares += clamped * clamped;
    }
    this._out.splice(0, count);
    const rms = Math.sqrt(sumSquares / count);
    this.port.postMessage({ type: "frame", frame, rms }, [frame.buffer]);
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
  /** worklet flush 应答的 resolve（flushMicTail 挂起期间非空）。 */
  const micFlushResolveRef = useRef<(() => void) | null>(null);

  const setPhase = (phase: VoiceInputPhase) => {
    phaseRef.current = phase;
    useVoiceInputStore.setState({ phase });
  };

  const failWith = (key: string, detail?: string) => {
    if (errorDismissTimerRef.current) clearTimeout(errorDismissTimerRef.current);
    useVoiceInputStore.setState({
      error: { key, ...(detail ? { detail } : {}) },
    });
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
      audioLevel: 0,
      error: null,
    });
    phaseRef.current = "idle";
  };

  const stopMic = () => {
    const mic = micRef.current;
    micRef.current = null;
    micFlushResolveRef.current = null;
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

  /**
   * 停麦前冲刷尾帧：worklet 按 100ms 整帧输出，直接停麦会丢掉重采样累加器里
   * <100ms 的尾部语音（用户反馈「最后半句没识别就返回了」）。向 worklet 发
   * flush 让它把剩余样本补发成一帧（经 onFrame 正常送 main），等 flushed
   * 应答（150ms 超时兜底）后再停麦、发起 finish——保证 worker 先收到全部
   * 音频再收到 finish，尾部识别完整后才返回结果（期间浮窗保持 finishing 态）。
   */
  const flushMicTail = async (): Promise<void> => {
    const mic = micRef.current;
    if (!mic) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        micFlushResolveRef.current = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 150);
      micFlushResolveRef.current = done;
      try {
        mic.node.port.postMessage({ type: "flush" });
      } catch {
        done();
      }
    });
    // 再让出一个宏任务：flush 帧（先于 flushed 发出）的转发此时已进事件队列，
    // 确保其 IPC send 先于 finish invoke。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  const setupMic = async (onFrame: (frame: Int16Array, rms: number) => void): Promise<void> => {
    // 指定设备用 exact 约束；设备已拔出时 getUserMedia 抛 OverconstrainedError，
    // 回退一次系统默认而不是让整次录音失败（spec §3.4）。
    const deviceId = latest.current.settings?.voiceInputDeviceId;
    const requestMic = (withDevice: boolean) =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          ...(withDevice && deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    let stream: MediaStream;
    try {
      stream = await requestMic(true);
    } catch (error) {
      if (deviceId && error instanceof OverconstrainedError) {
        logger.warn("voice mic device unavailable; falling back to system default", {
          deviceId,
          error: String(error),
        });
        stream = await requestMic(false);
      } else {
        throw error;
      }
    }
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
      const data = event.data;
      if (data && typeof data === "object") {
        if (data.type === "frame" && data.frame instanceof Int16Array) {
          onFrame(data.frame, typeof data.rms === "number" ? data.rms : 0);
        } else if (data.type === "flushed") {
          micFlushResolveRef.current?.();
        }
      } else if (data instanceof Int16Array) {
        // 防御：旧形态裸帧（理论不会出现）。
        onFrame(data, 0);
      }
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
    // 旧数据/未迁移选择可能缺思考档位：要求档位的模型会被 RPC 拒绝（实测
    // "Reasoning level is required"）。调用前懒补默认档位（最高档），视图不可用则按原样
    // 发出让 RPC 错误路径兜底（降级回填原文 + warn）。
    let selectionWithLevel = selection;
    let cleanupMaxOutputTokens = VOICE_CLEANUP_MAX_OUTPUT_TOKENS;
    {
      // 2026-10-14 二轮修复：语音整理是短文案润色任务，统一使用最低思考档——
      // 无论是存量保存了最高档还是新保存的，这里都覆写（用户反馈 GLM-5.3 在
      // 高思考档下既慢又容易耗尽输出预算导致返回原文）。
      const view = await currentServices.modelSelectionService.getView().catch(() => null);
      const provider = view?.providers?.find((p) => p.providerId === selection.providerId);
      const model = provider?.models?.find((m) => m.modelId === selection.modelId);
      const lowestLevel = model?.config?.optionSpecs?.reasoningLevel?.values?.[0];
      if (lowestLevel) {
        selectionWithLevel = { ...selection, reasoningLevel: lowestLevel };
      }
      // 2026-10-15：语义整理最大输出 Token 读 Provider 分组覆盖
      // （specs/provider/group-token-override.md）；未配置时维持既有 16384 调参。
      const groupOverride = provider?.config?.api?.maxOutputTokens;
      if (groupOverride != null) {
        cleanupMaxOutputTokens = groupOverride;
      }
    }
    const systemPrompt = currentIntl.formatMessage({
      id: "voice.cleanup.systemPrompt",
    });
    const userPrompt = currentIntl.formatMessage(
      { id: "voice.cleanup.userPrompt" },
      { transcript },
    );
    try {
      const result = await currentServices.zcodeAgentService.generateWorkspaceText({
        workspacePath: workspace.workspacePath,
        selection: {
          providerId: selectionWithLevel.providerId,
          modelId: selectionWithLevel.modelId,
          ...(selectionWithLevel.reasoningLevel
            ? {
                options: {
                  reasoningLevel: selectionWithLevel.reasoningLevel,
                },
              }
            : {}),
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        querySource: "voice-cleanup",
        // 2026-10-14 二轮：maxOutputTokens 8192→16384，配合最低思考档。思考型
        // 模型在高思考档下 8192 仍可能被 reasoning 耗尽；16384 + 最低档双保险。
        // 2026-10-15：Provider 分组覆盖存在时改用覆盖值（上方 provider 解析）。
        maxOutputTokens: cleanupMaxOutputTokens,
        requestTimeoutMs: CLEANUP_TIMEOUT_MS,
      });
      const text = result.text.trim();
      if (text.length === 0) {
        // 空文本此前静默回填，无法排障（2026-10-14 自测反馈根因）。补日志记录
        // finishReason 与用量，便于区分「reasoning 耗尽」vs「模型空回」。
        logger.warn("voice cleanup returned empty text; falling back to raw transcript", {
          finishReason: result.finishReason ?? "unknown",
          outputTokens: result.usage?.outputTokens ?? "unknown",
          reasoningTokens: result.usage?.reasoningTokens ?? "unknown",
          modelId: selectionWithLevel.modelId,
          maxOutputTokens: 8192,
        });
        return transcript;
      }
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
    // macOS TCC 预检（spec §3.5）：denied 时不再烧一次会话启动与 getUserMedia，
    // 直接给可引导的错误；not-determined 时 main 弹系统授权框。非 darwin 恒通过。
    if (currentPlatform.voiceEnsureMicPermission) {
      const permission = await currentPlatform.voiceEnsureMicPermission().catch(() => null);
      if (permission && permission.status !== "granted" && permission.status !== "unsupported") {
        failWith("voice.error.micDenied");
        return;
      }
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
      audioLevel: 0,
      error: null,
    });
    phaseRef.current = "preparing";

    // 麦克风授权与引擎准备并行（下载/加载可能耗时数十秒，授权弹窗同时出现）。
    const micPromise = setupMic((frame, rms) => {
      const session = sessionRef.current;
      // 音浪动画电平（store 仅渲染态；10Hz 更新不构成性能压力）。
      useVoiceInputStore.setState({ audioLevel: rms });
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

    sessionRef.current = {
      sessionId: sessionResult.sessionId,
      modelId: sessionResult.modelId,
    };
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
    // 先冲刷尾帧再停麦、再 finish：worker 必须先收齐全部音频（含 <100ms 尾帧）
    // 才能收到 finish；识别弹窗保持 finishing 态直到尾部识别完成。
    await flushMicTail();
    stopMic();
    useVoiceInputStore.setState({ audioLevel: 0 });
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
    // 错误态（如「未识别到语音」）允许关闭按钮/ESC 消隐——所有关闭路径都汇聚到
    // cancel，旧实现只在 preparing/listening 生效，error 态点 X 毫无反应（真机实测）。
    if (phaseRef.current === "error") {
      resetToIdle();
      return;
    }
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
        } else if (phase === "error") {
          // 错误态点麦克风 = 消隐错误（不立刻开录，防误触连开；spec §3.2）。
          cancel();
        }
        // finishing：不可取消（秒级）。
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
  }, []);
}
