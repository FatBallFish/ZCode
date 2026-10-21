import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { release } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { z } from "zod";
import type { CuaPermissionStatus, ICuaPermissionService } from "./cuaPermissionService.js";

const execute = promisify(execFile);
const ownerId = "dev.mikiko.computer-use";
class PermissionUnavailable extends Error {}
const restartFailureSchema = z.object({
  restarted: z.literal(false),
  error: z.object({ code: z.enum(["controller_busy", "identity_mismatch", "restart_failed"]) }),
});
const doctorSchema = z.object({
  platform: z.literal("macos"),
  appAgent: z.literal(true),
  grantOwnerBundleId: z.literal(ownerId),
  appPath: z.string().min(1),
  buildIdentifier: z.string().min(1),
  accessibilityTrusted: z.boolean(),
  screenCaptureGranted: z.boolean(),
  allGranted: z.boolean(),
  missingPermissions: z.array(z.string()),
});
export type MikikoComputerUsePermissionStatus = CuaPermissionStatus & {
  backend: "mikiko-native";
  appPath: string;
};
interface PermissionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  darwinRelease?: string;
  desktopLocal: boolean;
  isEnabled(context: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): boolean | Promise<boolean>;
  run?: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<{ stdout: string }>;
}

/** 权限仅来自本App的原生app-agent；不提供旧SDK方法、不拥有桌面控制租约。 */
export function createMikikoComputerUsePermissionService(
  options: PermissionOptions,
): ICuaPermissionService {
  const env = options.env ?? process.env;
  const run =
    options.run ??
    (async (file, args, commandOptions) =>
      execute(file, [...args], { ...commandOptions, encoding: "utf8", maxBuffer: 256 * 1024 }));
  async function invoke(
    command: "doctor" | "restart-agent",
    workspacePath?: string,
    workspaceIdentity?: string,
  ) {
    const darwinMajor = Number.parseInt(
      (options.darwinRelease ?? release()).split(".")[0] ?? "0",
      10,
    );
    if (
      !options.desktopLocal ||
      (options.platform ?? process.platform) !== "darwin" ||
      !Number.isFinite(darwinMajor) ||
      darwinMajor < 23
    ) {
      throw new PermissionUnavailable("Mikiko Computer Use requires a local macOS 14+ desktop.");
    }
    const path = workspacePath?.trim();
    const identity = workspaceIdentity?.trim();
    if (!path || !isAbsolute(path) || (identity && isRemoteWorkspaceIdentity(identity))) {
      throw new PermissionUnavailable("Mikiko Computer Use is unavailable for this workspace.");
    }
    if (
      !(await options.isEnabled({
        workspacePath: path,
        ...(identity ? { workspaceIdentity: identity } : {}),
      }))
    ) {
      throw new PermissionUnavailable("Mikiko Computer Use is disabled.");
    }
    const binary = env.MIKIKO_COMPUTER_USE_BINARY?.trim();
    const appPath = env.MIKIKO_COMPUTER_USE_APP_PATH?.trim();
    const server = env.MIKIKO_COMPUTER_USE_SERVER?.trim();
    if (!binary || !appPath || !server || ![binary, appPath, server].every(isAbsolute)) {
      throw new PermissionUnavailable("Mikiko Computer Use is not included in this build.");
    }
    await Promise.all([
      access(binary, constants.X_OK),
      access(appPath),
      access(server, constants.R_OK),
    ]);
    const [actualApp, actualBinary] = await Promise.all([realpath(appPath), realpath(binary)]);
    if (actualBinary !== join(actualApp, "Contents", "MacOS", "mikiko-computer-use")) {
      throw new PermissionUnavailable("Mikiko Computer Use resource identity is invalid.");
    }
    const commandEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => !key.startsWith("OPEN_COMPUTER_USE_") && !key.startsWith("MIKIKO_COMPUTER_USE_"),
      ),
    );
    Object.assign(commandEnv, {
      MIKIKO_COMPUTER_USE_BINARY: binary,
      MIKIKO_COMPUTER_USE_APP_PATH: appPath,
      MIKIKO_COMPUTER_USE_SERVER: server,
      MIKIKO_COMPUTER_USE_MODE: "production",
      MIKIKO_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: "mikiko-production",
    });
    const result = await run(binary, [command, "--json"], { env: commandEnv, timeout: 10_000 });
    const parsed: unknown = JSON.parse(result.stdout);
    let permissions: unknown = parsed;
    if (command === "restart-agent") {
      const restarted = z
        .object({ restarted: z.literal(true), permissions: z.unknown() })
        .parse(parsed);
      permissions = restarted.permissions;
    }
    const diagnostic = doctorSchema.parse(permissions);
    if (
      (await realpath(diagnostic.appPath)) !== actualApp ||
      diagnostic.allGranted !== (diagnostic.accessibilityTrusted && diagnostic.screenCaptureGranted)
    ) {
      throw new PermissionUnavailable("Mikiko Computer Use permission identity is invalid.");
    }
    // doctor 是TCC preflight，不能据此伪造截图/AX操作的功能验证成功。
    return {
      available: true,
      backend: "mikiko-native",
      appPath: actualApp,
      grantOwner: diagnostic.grantOwnerBundleId,
      grantOwnerDisplayName: "Mikiko Computer Use",
      accessibility: diagnostic.accessibilityTrusted ? "granted" : "denied",
      screenRecording: diagnostic.screenCaptureGranted ? "granted" : "denied",
      accessibilityProbeOk: false,
      screenCaptureProbeOk: false,
    } satisfies MikikoComputerUsePermissionStatus;
  }
  function failureReason(error: unknown) {
    return error instanceof PermissionUnavailable
      ? error.message
      : "Could not verify Mikiko Computer Use permission status.";
  }
  function restartFailureReason(error: unknown) {
    if (error instanceof PermissionUnavailable) return error.message;
    const stdout =
      error && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
    if (typeof stdout === "string") {
      try {
        const parsed = restartFailureSchema.safeParse(JSON.parse(stdout));
        if (parsed.success && parsed.data.error.code === "controller_busy") {
          return "Mikiko Computer Use is busy. Stop the active control session before restarting.";
        }
      } catch {
        /* 无机器可读错误时只报告重启失败，不按stderr文本猜测原因。 */
      }
    }
    return "Could not restart Mikiko Computer Use.";
  }
  return {
    async getStatus(workspacePath, workspaceIdentity) {
      try {
        return await invoke("doctor", workspacePath, workspaceIdentity);
      } catch (error) {
        return { available: false, reason: failureReason(error) };
      }
    },
    async restartHelper(workspacePath, workspaceIdentity) {
      try {
        await invoke("restart-agent", workspacePath, workspaceIdentity);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: restartFailureReason(error) };
      }
    },
  };
}
