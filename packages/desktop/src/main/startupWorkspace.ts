import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@zcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

// 修复原因：会话 CLI 没有 idle 回收，启动预热 3 个会让每个窗口常驻 3 份 Agent 进程内存；
// 切到最近项目的冷启动收益抵不上常驻成本，收敛为只预热 active workspace。
// 与 @zcode/protocol 的 init-local `agentWarmupTargets.max(1)` 保持一致。
export const STARTUP_AGENT_WARMUP_LIMIT = 1;

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  /** 窗口形态：session = 轻量会话窗口（仅会话页，见 SessionWindowRoot）。 */
  windowKind?: "main" | "session";
  /**
   * 会话窗口附着目标：源（主）窗口 webContents id。设置后本窗口不 spawn 自己的
   * Local Host，而是经 AttachServicePort 附着到该窗口的 Host（同运行时、同会话状态，
   * 与手机远控/刷新共用机制；specs/desktop/session-drag-out-window.md）。
   */
  attachToHostOfWindow?: number;
  initialWorkspacePath?: string;
  /** 身份隔离 key（identity workspace；本地路径场景缺省）。 */
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  /** 启动后直接定位到的会话（拖出新建窗口等入口）。 */
  initialTaskId?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  const sessions =
    settings.lastActiveWorkspace === undefined
      ? (settings.lastWorkspaceSession ?? [])
      : settings.lastActiveWorkspace
        ? [settings.lastActiveWorkspace]
        : [];
  const activeIndex = settings.lastActiveWorkspace === undefined ? settings.lastActiveTabIndex : 0;

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(sessions, activeIndex);
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // 上次激活 workspace 被移动或删除后，Agent 仍需保留原业务路径读取历史，
      // 但子进程 cwd 必须落在真实存在的目录；conversation backing workspace 只承担 cwd 兜底。
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(sessions, activeIndex);
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // 项目/最近目录不再决定 Agent 生命周期，只预热上次活动执行目录。
      const agentWarmupTargets = [{ workspacePath: activeSession.workspacePath }];
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    // 远程活动项没有本地预热目标，Host 会用此 app-owned cwd 准备会话库。
    // 切换数据根后该目录尚不存在；必须在交给 Host 前创建，否则 CLI 在发出存储帧前即退出。
    await mkdir(conversationWorkspaceDir, { recursive: true });
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // UI 可以没有项目，但 Agent 必须始终有真实 cwd。首次启动统一预热
  // app-managed conversation backing workspace，不能再创建会被误认成项目的 ZCodeProject。
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}
