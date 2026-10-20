import type { AppSettings, WorkspacePurpose } from "@zcode/shared";

export interface SelfHostedRemoteWorkspace {
  initialWorkspaceAbsPath: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  initialTaskId?: string;
}

/** 手机 attachment 不提供桌面账号/完整 Key 服务，UI 必须看到真实的可选能力缺席。 */
export function createSelfHostedRemoteUiServices<T extends { sub2ApiService?: unknown }>(
  services: T,
): Omit<T, "sub2ApiService"> & { sub2ApiService: undefined } {
  return { ...services, sub2ApiService: undefined };
}

export class SelfHostedRemoteWorkspaceError extends Error {
  constructor(readonly reason: "missing" | "remote") {
    super(
      reason === "remote"
        ? "Remote workspace requires its Source attachment"
        : "No active workspace",
    );
    this.name = "SelfHostedRemoteWorkspaceError";
  }
}

/** 只读已有窗口投影；不创建默认目录，不把其他 Source 的相同 cwd 当作本地身份。 */
export function readSelfHostedRemoteWorkspace(
  settings: Pick<AppSettings, "lastActiveWorkspace" | "lastActiveTaskByWorkspace">,
): SelfHostedRemoteWorkspace {
  const active = settings.lastActiveWorkspace;
  if (!active?.workspacePath.trim()) throw new SelfHostedRemoteWorkspaceError("missing");
  if (active.kind !== "local") throw new SelfHostedRemoteWorkspaceError("remote");
  const taskId = settings.lastActiveTaskByWorkspace?.[active.workspacePath]?.trim();
  return {
    initialWorkspaceAbsPath: active.workspacePath,
    ...(active.workspacePurpose ? { initialWorkspacePurpose: active.workspacePurpose } : {}),
    ...(taskId ? { initialTaskId: taskId } : {}),
  };
}
