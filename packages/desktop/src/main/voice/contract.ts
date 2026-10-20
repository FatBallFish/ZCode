/** Main VoiceService owns model downloads, worker lifetime and accepted voice sessions. */
export { createVoiceService } from "./desktopVoiceService.js";
export type {
  DesktopVoiceService,
  DesktopVoiceServiceOptions,
  VoiceEventSink,
} from "./desktopVoiceService.js";
export { createVoiceMicPermission } from "./voiceMicPermission.js";
export type { MicPermissionDeps } from "./voiceMicPermission.js";
