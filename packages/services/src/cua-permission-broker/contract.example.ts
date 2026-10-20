import {
  resolveStandaloneStatusLaunchAppPath,
  type StandaloneStatusLaunchAppPathOptions,
} from "./contract.js";
/** 显式注入存在性与安装动作；不存在时返回 null，不伪造成功状态。 */
export function resolveInstalledStatusApp(options: StandaloneStatusLaunchAppPathOptions) {
  return resolveStandaloneStatusLaunchAppPath(options);
}
