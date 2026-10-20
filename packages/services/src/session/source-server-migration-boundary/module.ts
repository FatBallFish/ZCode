export const sourceServerWorkspaceMigrationModule = {
  id: "source-server-workspace-migration",
  requires: ["services", "session", "shared", "sqlite-migrations"],
  provides: ["source-server-workspace-migration"],
  publicEntrypoints: [
    "contract.ts",
    "../sourceServerWorkspaceAliasRepo.ts",
    "../offPeakWorkspaceIdentityMigration.ts",
  ],
} as const;
