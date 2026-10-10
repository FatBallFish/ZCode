/**
 * 语音输入 UI 状态机（renderer 唯一事实源）—— specs/desktop/voice-input.md §4。
 * store 只持有渲染状态；麦克风采集与 IPC 副作用集中在 useVoiceInputController
 * （App 级单例挂载，经 bindVoiceInputController 注入 toggle/cancel）。
 * 快捷键、麦克风按钮、浮窗共用同一入口，天然保证互斥。
 */
import { create } from "zustand";

export type VoiceInputPhase = "idle" | "preparing" | "listening" | "finishing" | "error";

export interface VoiceInputErrorState {
  /** i18n message id（voice.error.*）。 */
  key: string;
  detail?: string;
}

export interface VoiceInputState {
  phase: VoiceInputPhase;
  sessionId: string | null;
  modelId: string | null;
  /** 累计识别文本（浮窗实时展示）。 */
  partialText: string;
  /** preparing 阶段的模型下载进度（首次使用时引擎会先下载模型）。 */
  downloadProgress: { receivedBytes: number; totalBytes: number; activeFile: string } | null;
  engineLoading: boolean;
  finishingStage: "transcribing" | "cleanup" | null;
  error: VoiceInputErrorState | null;
  toggle: () => void;
  cancel: () => void;
}

/** controller 绑定（幂等：App 卸载时置空）。 */
interface VoiceInputController {
  toggle(): void;
  cancel(): void;
}

let controller: VoiceInputController | null = null;

export function bindVoiceInputController(next: VoiceInputController | null): void {
  controller = next;
}

export const useVoiceInputStore = create<VoiceInputState>((set) => ({
  phase: "idle",
  sessionId: null,
  modelId: null,
  partialText: "",
  downloadProgress: null,
  engineLoading: false,
  finishingStage: null,
  error: null,
  toggle: () => controller?.toggle(),
  cancel: () => controller?.cancel(),
}));

export function isVoiceInputActive(phase: VoiceInputPhase): boolean {
  return phase !== "idle";
}
