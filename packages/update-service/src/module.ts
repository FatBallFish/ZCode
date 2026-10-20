export const mikikoUpdateHttpModule = {
  id: "mikiko-update-http",
  requires: [],
  provides: ["mikiko-update-http"],
  publicEntrypoints: ["contract.ts", "worker.ts"],
} as const;
