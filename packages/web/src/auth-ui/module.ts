export const webAuthUiModule = {
  id: "web-auth-ui",
  requires: ["shared", "ui", "web"],
  provides: ["web-auth-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "../auth/WebLoggedInWaitingPage.tsx"],
} as const;
