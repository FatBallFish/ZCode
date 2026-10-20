/** Renderer voice presentation and commands; microphone/session lifecycle belongs to the single controller. */
export { useVoiceInputStore, bindVoiceInputController } from "./voiceInputStore.js";
export type { VoiceInputPhase, VoiceInputState, VoiceInputErrorState } from "./voiceInputStore.js";
export {
  dispatchVoiceTranscriptAppend,
  appendVoiceTranscriptToComposer,
  isVoiceTranscriptAppendEvent,
} from "./voiceTranscript.js";
