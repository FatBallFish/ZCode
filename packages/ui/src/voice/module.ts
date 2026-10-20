export const voiceInputUiModule = {
  id: "voice-input-ui",
  requires: ["shared", "ui"],
  provides: ["voice-input-ui"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "ComposerVoiceInputButton.tsx",
    "VoiceInputOverlay.tsx",
    "useVoiceInputController.ts",
    "voiceInputStore.ts",
    "voiceTranscript.ts",
  ],
} as const;
