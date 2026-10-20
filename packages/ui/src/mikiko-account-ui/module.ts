export const mikikoAccountUiModule = {
  id: "mikiko-account-ui",
  requires: ["services", "shared", "ui"],
  provides: ["mikiko-account-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "../settings/Sub2ApiLoginPanel.tsx"],
} as const;
