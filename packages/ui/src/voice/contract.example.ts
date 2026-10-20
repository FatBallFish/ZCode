import { useVoiceInputStore } from "./contract.js";
/** The same command is shared by the shortcut, button and overlay. */
export function cancelFocusedVoiceCapture(): void {
  useVoiceInputStore.getState().cancel();
}
