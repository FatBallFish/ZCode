export const nativeSessionImportModule = {
  id: "native-session-import",
  requires: ["services", "session", "shared"],
  provides: ["native-session-import"],
  publicEntrypoints: [
    "contract.ts",
    "codexNativeSessionImportService.ts",
    "../claude-native/claudeNativeSessionImportService.ts",
  ],
} as const;
