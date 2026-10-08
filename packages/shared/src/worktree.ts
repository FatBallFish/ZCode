/**
 * Git Worktree 领域类型（specs/desktop/worktrees.md）。
 *
 * 语义对齐 Codex：创建即 detached HEAD、目录名随机、名称≠分支名；
 * 注册表唯一写入者是 host 内 WorktreeService，渲染层只持有只读缓存。
 */
import { z } from "zod";
import type { ZCodeTaskMeta, ZCodeTaskPersistStatus } from "./zcode-task-types-core.js";

/** 工作树配置（AppSettings.worktreeConfig，additive 免迁移）。 */
export interface WorktreeConfig {
  /** 工作树根目录，所有 Mikiko 创建的工作树落在此目录下。 */
  rootDir: string;
  /** 创建工作树前先 fetch 上游（无 remote 时静默跳过）。 */
  fetchBeforeCreate: boolean;
  /** 超限时自动删除最旧的合格工作树。 */
  autoPruneEnabled: boolean;
  /** 每个根项目的注册工作树上限（按根项目计数，D2）。 */
  autoPruneLimit: number;
}

export const DEFAULT_WORKTREE_ROOT_DIR = "~/.mikiko/worktrees";
export const WORKTREE_AUTO_PRUNE_LIMIT_MIN = 1;
export const WORKTREE_AUTO_PRUNE_LIMIT_MAX = 50;

export const worktreeConfigSchema = z.object({
  rootDir: z.string().trim().min(1),
  fetchBeforeCreate: z.boolean(),
  autoPruneEnabled: z.boolean(),
  autoPruneLimit: z
    .number()
    .int()
    .min(WORKTREE_AUTO_PRUNE_LIMIT_MIN)
    .max(WORKTREE_AUTO_PRUNE_LIMIT_MAX),
});

/** 兜底默认值：rootDir 中的 ~ 由服务端展开为真实 homedir 后再生效。 */
export function createDefaultWorktreeConfig(rootDir: string): WorktreeConfig {
  return {
    rootDir,
    fetchBeforeCreate: true,
    autoPruneEnabled: false,
    autoPruneLimit: 5,
  };
}

/** 注册表条目（~/.mikiko/v2/worktrees.json）。 */
export interface WorktreeRegistryEntry {
  /** 8 位随机 hex，同时是工作树目录名；展示用前 4 位。 */
  id: string;
  /** 根项目绝对路径。 */
  rootWorkspacePath: string;
  /** 工作树绝对路径。 */
  worktreePath: string;
  /** 创建时使用的起点 ref（分支名或远程默认分支 ref）。 */
  ref: string;
  /** 可选短描述名；不等于 git 分支名（Codex 语义）。 */
  name: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export const worktreeRegistryEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}$/),
  rootWorkspacePath: z.string().min(1),
  worktreePath: z.string().min(1),
  ref: z.string().min(1),
  name: z.string().nullable(),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().min(1),
});

/** 工作树在磁盘/git 层的对账状态。 */
export type WorktreeDiskStatus =
  | "ready"
  /** 目录被外部删除/未 checkout。 */
  | "missing"
  /** git worktree list 不再包含（已 prune 或手动移除）。 */
  | "pruned";

/** 列表项：注册条目 + git 状态摘要 + 关联会话（按 workspace_path 精确匹配）。 */
export interface WorktreeOverviewItem {
  entry: WorktreeRegistryEntry;
  diskStatus: WorktreeDiskStatus;
  /** 工作树内未提交变更文件数（git status --porcelain）；missing/pruned 时为 null。 */
  dirtyFileCount: number | null;
  /** detached HEAD 当前指向的短 SHA（展示用）。 */
  headShortSha: string | null;
  /** 该工作树下的会话（按更新时间倒序）。 */
  sessions: Array<{
    taskId: ZCodeTaskMeta["taskId"];
    title: ZCodeTaskMeta["title"];
    status?: ZCodeTaskPersistStatus;
    updatedAt: ZCodeTaskMeta["updatedAt"];
  }>;
}

export interface WorktreeRootGroup {
  /** 根项目绝对路径。 */
  rootWorkspacePath: string;
  /** 根项目目录名（展示用）。 */
  repoName: string;
  worktrees: WorktreeOverviewItem[];
}

export interface WorktreeListResult {
  groups: WorktreeRootGroup[];
}

export interface WorktreeCreateInput {
  rootWorkspacePath: string;
  /** 起始 ref；缺省取远程默认分支。 */
  ref?: string;
}

export interface WorktreeRemoveInput {
  worktreePath: string;
  /** 脏树强制删除（UI 需二次确认后才传 true）。 */
  force?: boolean;
}

export type WorktreeRemoveBlockReason = "not-found" | "process-alive" | "dirty" | "git-error";

export interface WorktreeRemoveResult {
  removed: boolean;
  blockReason?: WorktreeRemoveBlockReason;
  /** 阻止/失败时的可展示信息（git 原始 stderr 或友好描述）。 */
  message?: string;
  /** 连同删除的会话数（D1）。 */
  removedSessionCount: number;
}

export const worktreeOverviewItemSchema = z.object({
  entry: worktreeRegistryEntrySchema,
  diskStatus: z.enum(["ready", "missing", "pruned"]),
  dirtyFileCount: z.number().int().nonnegative().nullable(),
  headShortSha: z.string().nullable(),
  sessions: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      status: z.string().optional(),
      updatedAt: z.number(),
    }),
  ),
});

export const worktreeListResultSchema = z.object({
  groups: z.array(
    z.object({
      rootWorkspacePath: z.string(),
      repoName: z.string(),
      worktrees: z.array(worktreeOverviewItemSchema),
    }),
  ),
});
