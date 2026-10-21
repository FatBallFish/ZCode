import type { RemoteTarget } from "@zcode/shared";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export type ComputerUseAvailabilityKind =
  | "local-macos"
  | "local-windows"
  | "local-linux"
  | "remote-ssh"
  | "remote-wsl"
  | "remote-docker"
  | "remote-server"
  | "web";

export interface ComputerUseAvailability {
  kind: ComputerUseAvailabilityKind;
  supported: boolean;
  /**
   * Windows/Linux 本地桌面的实验标记（上游 open-computer-use 声明 experimental）。
   * 与 `CuaOsSupport.supported.experimental` 同源：本地 mac 稳定支持不带该字段，
   * UI 据此展示 BETA 角标与实验警告卡。
   */
  experimental?: boolean;
}

export interface ComputerUseAvailabilityInput {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  workspaceIdentity?: string | null;
}

export function resolveComputerUseAvailability({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  remoteSessionId,
  remoteTarget,
  workspaceIdentity,
}: ComputerUseAvailabilityInput = {}): ComputerUseAvailability {
  const isRemote = Boolean(
    remoteSessionId ||
    remoteTarget ||
    (workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim())),
  );
  if (isRemote) {
    const remoteKind: ComputerUseAvailabilityKind =
      remoteTarget?.kind === "ssh"
        ? "remote-ssh"
        : remoteTarget?.kind === "wsl"
          ? "remote-wsl"
          : remoteTarget?.kind === "docker"
            ? "remote-docker"
            : "remote-server";
    return {
      kind: remoteKind,
      supported: false,
    };
  }
  if (!isDesktop) return { kind: "web", supported: false };
  // 本地桌面三分支均 supported（docs/specs/computer-use-experimental-platforms.md）：
  // macOS 稳定支持；Windows/Linux 基于上游 open-computer-use 实验运行时，supported 但标记 experimental。
  if (isMacDesktop) return { kind: "local-macos", supported: true };
  if (isWindowsDesktop) {
    return { kind: "local-windows", supported: true, experimental: true };
  }
  return { kind: "local-linux", supported: true, experimental: true };
}

const COMPUTER_USE_SEARCH_TERMS = ["电脑控制", "computer use", "zcode-cua", "cua"];

export function matchesComputerUseSearch(query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return COMPUTER_USE_SEARCH_TERMS.some((term) => term.includes(normalized));
}

/**
 * 目标环境是否完全不可用（远端 SSH/WSL/Docker/Server）。Web 归入单独分支（kind === "web"），
 * 由调用方自行表述；本地 Windows/Linux 桌面自实验支持落地后为 supported，不再命中本判定。
 * 表达式保持 `!supported && kind !== "web"` 不变，语义收敛为「远端不可用」。
 */
export function isComputerUseUnavailableTarget(availability: ComputerUseAvailability): boolean {
  return !availability.supported && availability.kind !== "web";
}
