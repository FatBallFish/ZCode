/** App/CLI workspace身份迁移复用AliasRepo单一事务owner。 */
export {
  SourceServerWorkspaceAliasRepo,
  SourceServerWorkspaceIdentityConflictError,
  SourceServerWorkspaceConfigConflictError,
  SourceServerWorkspaceMigrationPlanDivergedError,
  SourceServerWorkspaceSessionGenerationChangedError,
  WORKSPACE_MIGRATION_PHASES,
} from "../sourceServerWorkspaceAliasRepo.js";
export type {
  SourceServerWorkspaceAliasRepoOptions,
  ResolveCanonicalWorkspaceKeyInput,
  ResolveCanonicalWorkspaceKeyResult,
  WorkspaceMigrationPhase,
} from "../sourceServerWorkspaceAliasRepo.js";
