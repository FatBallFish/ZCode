/**
 * Worktree 管理编排（specs/desktop/worktrees.md）。
 *
 * 职责：创建（detached、随机目录、可选 fetch、自动清理 D2/D4）、
 * 删除（D1 连同会话历史；进程存活/脏树资格校验）、列表（git 对账 + 会话关联）。
 * 注册表唯一写入者；git plumbing 在 repo/gitWorktreeRepo.ts。
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type {
  WorktreeConfig,
  WorktreeCreateInput,
  WorktreeListResult,
  WorktreeOverviewItem,
  WorktreeRegistryEntry,
  WorktreeRemoveInput,
  WorktreeRemoveResult,
  WorktreeRootGroup,
} from "@zcode/shared";
import { createDefaultWorktreeConfig } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { GitCliRepo } from "./repo/gitCliRepo.js";
import type { GitWorktreeRepo } from "./repo/gitWorktreeRepo.js";
import type { WorktreeRegistry } from "./worktreeRegistry.js";
import { generateWorktreeId } from "./worktreeRegistry.js";
import type { IWorktreeService } from "./worktree.js";

const log = createServiceLogger("worktree");

export interface CreateWorktreeServiceOptions {
  worktreeRepo: GitWorktreeRepo;
  gitCliRepo: GitCliRepo;
  registry: WorktreeRegistry;
  /** 每次操作时现读设置（host 进程内 settingService），无缓存失效问题。 */
  resolveConfig: () => Promise<WorktreeConfig | undefined>;
  /** 会话关联与删除（tasks-index 同进程直查）。 */
  taskIndexRepo: TaskIndexRepo;
  /** 该 workspace 是否仍有存活 Agent CLI 进程（删除资格 D4）。 */
  isWorkspaceRuntimeAlive: (workspacePath: string) => boolean;
  /**
   * 优雅停止该 workspace 的 Agent runtime（node.ts 注入 zcodeAgentService.disposeWorkspace）。
   * 仅供强制删除使用：空闲进程挡住删除时先回收，再执行 git worktree remove --force。
   */
  disposeWorkspaceRuntime: (workspacePath: string) => Promise<void>;
  /** 会话删除后的列表刷新广播（node.ts 注入 syncer.emitWorkspaceTaskListChanged）。 */
  emitWorkspaceTasksChanged: (workspacePath: string) => void;
}

/** 列表里每个工作树最多展示的会话条数（避免大列表拖慢设置页）。 */
const MAX_SESSIONS_PER_WORKTREE = 20;

function expandHomeDir(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~" + sep)) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function normalizeFsPath(pathValue: string): string {
  const expanded = expandHomeDir(pathValue.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/** `<rootDir>/<repoName>-<hash4(rootPath)>/<id8>`；hash4 让同名仓库不互相覆盖。 */
export function buildWorktreeDirectoryPath(options: {
  rootDir: string;
  rootWorkspacePath: string;
  id: string;
}): string {
  const repoName = basename(options.rootWorkspacePath) || "repo";
  const hash4 = createHash("sha256")
    .update(resolve(options.rootWorkspacePath))
    .digest("hex")
    .slice(0, 4);
  return join(normalizeFsPath(options.rootDir), `${repoName}-${hash4}`, options.id);
}

async function resolveWorktreeConfig(
  options: CreateWorktreeServiceOptions,
): Promise<WorktreeConfig> {
  const stored = await options.resolveConfig();
  if (!stored) {
    return createDefaultWorktreeConfig("~/.mikiko/worktrees");
  }
  return stored;
}

export function createWorktreeService(options: CreateWorktreeServiceOptions): IWorktreeService {
  const { worktreeRepo, gitCliRepo, registry, taskIndexRepo } = options;

  /** 内部删除链路：git remove → prune → 注册表移除 → 会话 tombstone（D1）。 */
  async function removeWorktreeInternal(
    entry: WorktreeRegistryEntry,
    force: boolean,
  ): Promise<WorktreeRemoveResult> {
    try {
      await worktreeRepo.removeWorktree(entry.rootWorkspacePath, entry.worktreePath, force);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 脏树（contains modified or untracked files）与通用 git 错误分开提示。
      const isDirty = /contains modified or untracked files|is dirty/i.test(message);
      return {
        removed: false,
        blockReason: isDirty ? "dirty" : "git-error",
        message,
        removedSessionCount: 0,
      };
    }
    try {
      await worktreeRepo.pruneWorktrees(entry.rootWorkspacePath);
    } catch (error) {
      // prune 只是 .git/worktrees 元数据兜底清理，失败不阻塞主流程。
      log.warn(undefined, "[Worktree] prune 失败（忽略）", {
        worktreePath: entry.worktreePath,
        error,
      });
    }
    await registry.mutate((entries) => {
      const index = entries.findIndex((item) => item.worktreePath === entry.worktreePath);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    });
    // D1：连同删除会话历史（tombstone 防止 sessions-index 复活）。
    let removedSessionCount = 0;
    try {
      removedSessionCount = await taskIndexRepo.deleteWorkspaceTasks({
        workspacePath: entry.worktreePath,
      });
    } catch (error) {
      log.error(undefined, "[Worktree] 会话清理失败（git 侧已删除）", {
        worktreePath: entry.worktreePath,
        error,
      });
    }
    if (removedSessionCount > 0) {
      options.emitWorkspaceTasksChanged(entry.worktreePath);
    }
    log.info(undefined, "[Worktree] 已删除", {
      worktreePath: entry.worktreePath,
      rootWorkspacePath: entry.rootWorkspacePath,
      force,
      removedSessionCount,
    });
    return { removed: true, removedSessionCount };
  }

  /** 自动清理（D2 按根项目计数；D4 资格校验；遇不可删即停）。 */
  async function autoPrune(params: {
    config: WorktreeConfig;
    rootWorkspacePath: string;
    excludeWorktreePath: string;
  }): Promise<void> {
    if (!params.config.autoPruneEnabled) {
      return;
    }
    const entries = await registry.load();
    const siblings = entries.filter(
      (item) =>
        normalizeFsPath(item.rootWorkspacePath) === normalizeFsPath(params.rootWorkspacePath) &&
        item.worktreePath !== params.excludeWorktreePath,
    );
    let excess = siblings.length + 1 - params.config.autoPruneLimit;
    if (excess <= 0) {
      return;
    }
    const ordered = [...siblings].sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
    for (const candidate of ordered) {
      if (excess <= 0) {
        break;
      }
      if (options.isWorkspaceRuntimeAlive(candidate.worktreePath)) {
        log.warn(undefined, "[Worktree] 自动清理跳过：进程存活", {
          worktreePath: candidate.worktreePath,
        });
        break;
      }
      const dirtyCount = await worktreeRepo.getWorktreeDirtyFileCount(candidate.worktreePath);
      if (dirtyCount === null) {
        // 目录已缺失：直接清注册表 + 会话 tombstone，无需 git remove。
        log.warn(undefined, "[Worktree] 自动清理：目录缺失，仅清注册表与会话", {
          worktreePath: candidate.worktreePath,
        });
        await removeWorktreeInternal(candidate, true);
        excess -= 1;
        continue;
      }
      if (dirtyCount > 0) {
        log.warn(undefined, "[Worktree] 自动清理跳过：工作树有未提交变更", {
          worktreePath: candidate.worktreePath,
          dirtyFileCount: dirtyCount,
        });
        break;
      }
      if (await taskIndexRepo.hasPinnedOrUnreadTasks({ workspacePath: candidate.worktreePath })) {
        log.warn(undefined, "[Worktree] 自动清理跳过：存在置顶/未读会话", {
          worktreePath: candidate.worktreePath,
        });
        break;
      }
      const result = await removeWorktreeInternal(candidate, false);
      if (result.removed) {
        excess -= 1;
      } else {
        break;
      }
    }
  }

  return {
    async list(): Promise<WorktreeListResult> {
      const entries = await registry.load();
      const byRoot = new Map<string, WorktreeRegistryEntry[]>();
      for (const entry of entries) {
        const rootKey = normalizeFsPath(entry.rootWorkspacePath);
        const bucket = byRoot.get(rootKey);
        if (bucket) {
          bucket.push(entry);
        } else {
          byRoot.set(rootKey, [entry]);
        }
      }
      const groups: WorktreeRootGroup[] = [];
      for (const [rootKey, rootEntries] of byRoot) {
        // 对账真值：git worktree list（主树根目录执行）。主树目录被删时全部标记 missing。
        let diskPaths: Set<string> | null = null;
        try {
          const listed = await worktreeRepo.listWorktrees(rootKey);
          diskPaths = new Set(listed.map((item) => normalizeFsPath(item.path)));
        } catch (error) {
          log.warn(undefined, "[Worktree] list 对账失败，回退注册表", { rootKey, error });
        }
        const items: WorktreeOverviewItem[] = [];
        for (const entry of rootEntries) {
          const normalizedWorktreePath = normalizeFsPath(entry.worktreePath);
          let diskStatus: WorktreeOverviewItem["diskStatus"] = "ready";
          if (diskPaths && !diskPaths.has(normalizedWorktreePath)) {
            diskStatus = "pruned";
          }
          let dirtyFileCount: number | null = null;
          let headShortSha: string | null = null;
          if (diskStatus === "ready") {
            [dirtyFileCount, headShortSha] = await Promise.all([
              worktreeRepo.getWorktreeDirtyFileCount(normalizedWorktreePath),
              worktreeRepo.getWorktreeHeadShortSha(normalizedWorktreePath),
            ]);
            if (dirtyFileCount === null) {
              diskStatus = "missing";
            }
          }
          const sessions = await taskIndexRepo
            .listTaskMetas({ workspacePath: normalizedWorktreePath })
            .then((metas) =>
              metas.slice(0, MAX_SESSIONS_PER_WORKTREE).map((meta) => ({
                taskId: meta.taskId,
                title: meta.title,
                status: meta.status,
                updatedAt: meta.updatedAt,
              })),
            )
            .catch((error) => {
              log.warn(undefined, "[Worktree] 关联会话查询失败", {
                worktreePath: normalizedWorktreePath,
                error,
              });
              return [];
            });
          items.push({ entry, diskStatus, dirtyFileCount, headShortSha, sessions });
        }
        items.sort((a, b) => b.entry.lastUsedAt.localeCompare(a.entry.lastUsedAt));
        groups.push({
          rootWorkspacePath: rootKey,
          repoName: basename(rootKey),
          worktrees: items,
        });
      }
      groups.sort((a, b) => a.repoName.localeCompare(b.repoName));
      return { groups };
    },

    async create(params: WorktreeCreateInput): Promise<WorktreeRegistryEntry> {
      const config = await resolveWorktreeConfig(options);
      const normalizedRoot = normalizeFsPath(params.rootWorkspacePath);
      const resolution = await gitCliRepo.resolveRepository(normalizedRoot);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        throw new Error(`not a git repository: ${normalizedRoot}`);
      }
      if (config.fetchBeforeCreate) {
        try {
          await worktreeRepo.fetchRemote(resolution.repoRoot);
        } catch (error) {
          // fetch 失败（离线等）不阻塞创建：按本地已有 ref 继续，warn 记录。
          log.warn(undefined, "[Worktree] fetch 上游失败，按本地 ref 继续", {
            repoRoot: resolution.repoRoot,
            error,
          });
        }
      }
      let actualRef = params.ref?.trim();
      if (!actualRef) {
        actualRef = (await worktreeRepo.resolveRemoteDefaultBranch(resolution.repoRoot)) ?? "HEAD";
      }
      const id = generateWorktreeId();
      const worktreePath = buildWorktreeDirectoryPath({
        rootDir: config.rootDir,
        rootWorkspacePath: normalizedRoot,
        id,
      });
      await worktreeRepo.addDetachedWorktree(resolution.repoRoot, worktreePath, actualRef);
      const now = new Date().toISOString();
      const entry: WorktreeRegistryEntry = {
        id,
        rootWorkspacePath: normalizedRoot,
        worktreePath,
        ref: actualRef,
        name: null,
        createdAt: now,
        lastUsedAt: now,
      };
      await registry.mutate((entries) => {
        entries.push(entry);
      });
      log.info(undefined, "[Worktree] 已创建", {
        worktreePath,
        rootWorkspacePath: normalizedRoot,
        ref: actualRef,
      });
      await autoPrune({
        config,
        rootWorkspacePath: normalizedRoot,
        excludeWorktreePath: worktreePath,
      });
      return entry;
    },

    async remove(params: WorktreeRemoveInput): Promise<WorktreeRemoveResult> {
      const normalizedTarget = normalizeFsPath(params.worktreePath);
      const entries = await registry.load();
      const entry = entries.find((item) => normalizeFsPath(item.worktreePath) === normalizedTarget);
      if (!entry) {
        return {
          removed: false,
          blockReason: "not-found",
          removedSessionCount: 0,
        };
      }
      if (options.isWorkspaceRuntimeAlive(normalizedTarget)) {
        // 强制删除允许回收「空闲」runtime（无 running 任务）；有任务在跑仍然拒绝——
        // 杀掉执行中的 Agent 会丢失进行中的工作，不属于删除确认的授权范围。
        if (params.force) {
          if (await taskIndexRepo.hasRunningTasks({ workspacePath: normalizedTarget })) {
            return {
              removed: false,
              blockReason: "process-alive",
              message: "a task is still running in this worktree",
              removedSessionCount: 0,
            };
          }
          try {
            await options.disposeWorkspaceRuntime(normalizedTarget);
          } catch (error) {
            log.warn(undefined, "[Worktree] 停止空闲 runtime 失败", {
              worktreePath: normalizedTarget,
              error,
            });
          }
          // dispose 是异步回收；有限等待进程真正退出后再继续，避免 remove 与进程占用竞争。
          const waitDeadline = Date.now() + 5000;
          while (options.isWorkspaceRuntimeAlive(normalizedTarget) && Date.now() < waitDeadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 200));
          }
          if (options.isWorkspaceRuntimeAlive(normalizedTarget)) {
            return {
              removed: false,
              blockReason: "process-alive",
              message: "agent process did not stop in time",
              removedSessionCount: 0,
            };
          }
        } else {
          return {
            removed: false,
            blockReason: "process-alive",
            message: "agent process still running in this worktree",
            removedSessionCount: 0,
          };
        }
      }
      if (!params.force) {
        const dirtyCount = await worktreeRepo.getWorktreeDirtyFileCount(normalizedTarget);
        if (dirtyCount !== null && dirtyCount > 0) {
          return {
            removed: false,
            blockReason: "dirty",
            message: `worktree has ${dirtyCount} uncommitted change(s)`,
            removedSessionCount: 0,
          };
        }
      }
      return removeWorktreeInternal(entry, params.force ?? false);
    },

    async touch(params: { worktreePath: string }): Promise<void> {
      const normalizedTarget = normalizeFsPath(params.worktreePath);
      await registry.mutate((entries) => {
        const entry = entries.find(
          (item) => normalizeFsPath(item.worktreePath) === normalizedTarget,
        );
        if (entry) {
          entry.lastUsedAt = new Date().toISOString();
        }
      });
    },
  };
}
