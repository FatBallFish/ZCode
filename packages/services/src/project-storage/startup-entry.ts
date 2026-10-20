export { prepareTasksIndexStorage } from "#src/project-storage/startup.js";
export { markTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultZCodeAgentCommand } from "#src/zcode-agent/zcodeAgentProcessManager.js";
export { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";

export { createSettingService } from "#src/setting/settingService.js";
export { createSettingServiceWithMigrations } from "#src/setting/settingService.js";
export {
  planProjectSeedRecovery,
  applyProjectSeedRecovery,
  fingerprintProjectDatabase,
} from "#src/project-storage/project-seed-recovery.js";
export type {
  ProjectSeedRecoveryFiles,
  ProjectSeedRecoveryPlan,
} from "#src/project-storage/project-seed-recovery.js";
