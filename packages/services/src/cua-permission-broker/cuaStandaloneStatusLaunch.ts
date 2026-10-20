import { homedir } from "node:os";
import { join } from "node:path";

import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  isCuaLocalDevelopmentRuntime,
  resolveCuaHelperInstallRoot,
  resolveHelperAppName,
  standaloneHelperCandidatePaths,
} from "@zcode/zcode-cua/broker/server";

export function resolveStandaloneStatusLaunchCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [...standaloneHelperCandidatePaths(env)];
  if (isCuaLocalDevelopmentRuntime(env)) {
    const installRoot = resolveCuaHelperInstallRoot(env);
    if (installRoot) {
      const fallbackName =
        resolveHelperAppName(env) === DEV_HELPER_APP_NAME ? HELPER_APP_NAME : DEV_HELPER_APP_NAME;
      candidates.push(join(installRoot, fallbackName));
    }
  }
  // 开源构建的 zcode-cua broker-server 是 stub（standaloneHelperCandidatePaths 恒为空），
  // 但 Mikiko 构建会实际安装 Computer Use Helper，按安装布局枚举本机候选：
  // dev 是独立子根 `dev/` 且 app 名换成 DEV_HELPER_APP_NAME；preview 是独立子根 `preview/`
  // 但沿用稳定 app 名（分根是因为 build id 不同，共享根会互相覆盖安装）。
  // dev 的两种名字都保留：一键 dev bundle 也可能装成稳定名，漏掉会导致设置页拉起静默失败。
  const home = env.MIKIKO_HOME?.trim() || join(homedir(), ".mikiko");
  const baseRoot = join(home, "computer-use");
  candidates.push(
    join(baseRoot, "dev", DEV_HELPER_APP_NAME),
    join(baseRoot, "dev", HELPER_APP_NAME),
    join(baseRoot, HELPER_APP_NAME),
    join(baseRoot, "preview", HELPER_APP_NAME),
  );
  return candidates;
}

export interface StandaloneStatusLaunchAppPathOptions {
  env: NodeJS.ProcessEnv;
  bundledAppPath: string | undefined;
  exists: (path: string) => boolean;
  ensureInstalled: (bundledAppPath: string) => Promise<string>;
}

export async function resolveStandaloneStatusLaunchAppPath({
  env,
  bundledAppPath,
  exists,
  ensureInstalled,
}: StandaloneStatusLaunchAppPathOptions): Promise<string | null> {
  if (bundledAppPath && exists(bundledAppPath)) {
    return ensureInstalled(bundledAppPath);
  }
  return resolveStandaloneStatusLaunchCandidates(env).find(exists) ?? null;
}
