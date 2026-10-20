export const cuaPermissionBrokerModule = {
  id: "cua-permission-broker",
  requires: ["services", "shared"],
  provides: ["cua-permission-broker"],
  publicEntrypoints: ["index.ts", "contract.ts", "cuaStandaloneStatusLaunch.ts"],
} as const;
