export const selfHostedRemoteUiModule = {
  id: "self-hosted-remote-ui",
  requires: ["shared", "ui"],
  provides: ["self-hosted-remote-ui"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "RemoteControlDialog.tsx",
    "useRemoteControl.ts",
    "BotChannelSection.tsx",
    "deviceUa.ts",
  ],
} as const;
