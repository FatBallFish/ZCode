export const mikikoCloudModule = {
  id: "mikiko-cloud",
  requires: [],
  provides: ["mikiko-cloud"],
  publicEntrypoints: ["contract.ts", "worker.ts"],
} as const;
