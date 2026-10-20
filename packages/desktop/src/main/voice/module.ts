export const desktopVoiceInputModule = {
  id: "desktop-voice-input",
  requires: ["shared"],
  provides: ["desktop-voice-input"],
  publicEntrypoints: [
    "contract.ts",
    "desktopVoiceService.ts",
    "desktopVoiceIpc.ts",
    "voiceMicPermission.ts",
    "voiceEngineProtocol.ts",
  ],
} as const;
