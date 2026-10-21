/** 仅公开当前开源分发已有的安装/启动适配边界，不承诺恢复内部 CUA 实现。 */
export {
  resolveStandaloneStatusLaunchCandidates,
  resolveStandaloneStatusLaunchAppPath,
} from "./cuaStandaloneStatusLaunch.js";
export type { StandaloneStatusLaunchAppPathOptions } from "./cuaStandaloneStatusLaunch.js";
export { createMikikoComputerUsePermissionService } from "./mikikoComputerUsePermission.js";
export type { MikikoComputerUsePermissionStatus } from "./mikikoComputerUsePermission.js";
