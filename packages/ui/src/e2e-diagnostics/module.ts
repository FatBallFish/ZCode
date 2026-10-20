export const uiE2EDiagnosticsModule = {
  id: "ui-e2e-diagnostics",
  requires: [],
  provides: ["ui-e2e-diagnostics"],
  publicEntrypoints: ["index.ts", "contract.ts", "../lib/e2eStoreBridge.ts"],
} as const;
