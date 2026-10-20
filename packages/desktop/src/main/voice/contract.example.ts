import type { DesktopVoiceService } from "./contract.js";
/** Renderer cancellation reaches the existing voice session owner; no engine is started here. */
export function cancelVoiceSession(owner: DesktopVoiceService, sessionId: string) {
  owner.cancelSession(sessionId);
}
