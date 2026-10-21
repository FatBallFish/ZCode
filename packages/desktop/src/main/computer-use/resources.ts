import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface MikikoComputerUseResources {
  appPath: string;
  binary: string;
  server: string;
}
export function mikikoComputerUsePermissionSettingsUrl(kind: unknown): string {
  if (kind !== "accessibility" && kind !== "screen_recording")
    throw new Error("Invalid Computer Use permission");
  return `x-apple.systempreferences:com.apple.preference.security?${kind === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture"}`;
}
export function resolveMikikoComputerUseResources(options: {
  platform: string;
  arch: string;
  isPackaged: boolean;
  resourcesPath: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): MikikoComputerUseResources | undefined {
  if (options.platform !== "darwin" && options.platform !== "win32" && options.platform !== "linux")
    return undefined;
  const env = options.env ?? process.env;
  const exists = options.exists ?? (() => true);
  if (options.platform !== "darwin") {
    // Windows/Linux 实验运行时：无 .app 包，布局为交叉构建的二进制 + 平台无关 gateway。
    // dev 态优先 env 覆盖，其次 cross 缓存（见 scripts/build-mikiko-computer-use-cross.mjs）。
    const suffix = options.platform === "win32" ? ".exe" : "";
    const binary = options.isPackaged
      ? join(
          options.resourcesPath,
          "computer-use",
          `mikiko-computer-use-${options.platform}-${options.arch}${suffix}`,
        )
      : env.MIKIKO_COMPUTER_USE_BINARY?.trim() ||
        join(
          options.workspaceRoot,
          ".cache",
          "mikiko-computer-use",
          "cross",
          "production",
          options.platform,
          options.arch === "x64" ? "amd64" : options.arch,
          `mikiko-computer-use-${options.platform}-${options.arch}${suffix}`,
        );
    const server = options.isPackaged
      ? join(options.resourcesPath, "computer-use", "production-server.mjs")
      : env.MIKIKO_COMPUTER_USE_SERVER?.trim() ||
        join(
          options.workspaceRoot,
          "packages",
          "desktop",
          "bundled-tools",
          `${options.platform}-${options.arch}`,
          "mikiko-computer-use",
          "production-server.mjs",
        );
    if (![binary, server].every((path) => isAbsolute(path) && exists(path))) return undefined;
    return { appPath: binary, binary, server };
  }
  const cache = join(options.workspaceRoot, ".cache", "mikiko-computer-use", "production");
  const appPath = options.isPackaged
    ? join(options.resourcesPath, "computer-use", "Mikiko Computer Use.app")
    : env.MIKIKO_COMPUTER_USE_APP_PATH?.trim() ||
      join(
        cache,
        options.arch === "x64" ? "x86_64" : options.arch,
        "release",
        "Mikiko Computer Use.app",
      );
  const binary =
    !options.isPackaged && env.MIKIKO_COMPUTER_USE_BINARY?.trim()
      ? env.MIKIKO_COMPUTER_USE_BINARY.trim()
      : join(appPath, "Contents", "MacOS", "mikiko-computer-use");
  const server = options.isPackaged
    ? join(options.resourcesPath, "computer-use", "production-server.mjs")
    : env.MIKIKO_COMPUTER_USE_SERVER?.trim() || join(cache, "production-server.mjs");
  if (![appPath, binary, server].every((path) => isAbsolute(path) && exists(path)))
    return undefined;
  return { appPath, binary, server };
}

export async function areMikikoComputerUseResourcesAvailable(
  resources: MikikoComputerUseResources | undefined,
): Promise<boolean> {
  if (!resources) return false;
  try {
    await Promise.all([
      access(resources.appPath),
      access(resources.binary, constants.X_OK),
      access(resources.server, constants.R_OK),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Main仅提供资源位置；权限、会话与控制租约分别由Host/native持有。 */
export function mikikoComputerUseResourceEnv(
  resources: MikikoComputerUseResources | undefined,
): Record<string, string> {
  return {
    MIKIKO_COMPUTER_USE_BACKEND: "open-computer-use",
    MIKIKO_COMPUTER_USE_MODE: "production",
    ...(resources
      ? {
          MIKIKO_COMPUTER_USE_BINARY: resources.binary,
          MIKIKO_COMPUTER_USE_APP_PATH: resources.appPath,
          MIKIKO_COMPUTER_USE_SERVER: resources.server,
        }
      : {}),
  };
}
