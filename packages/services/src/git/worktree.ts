/**
 * Git Worktree 管理服务接口（specs/desktop/worktrees.md）。
 *
 * 注册于 createLocalServices（本地 host）；刻意不加入远程 workspace 集合
 * 与 legacy 远程契约——手机远控经本地 attachment 天然可达，SSH 远端旧版本
 * 会因缺 channel 直接抛错（版本硬校验），v1 不接入。
 */
import type {
  WorktreeCreateInput,
  WorktreeListResult,
  WorktreeRegistryEntry,
  WorktreeRemoveInput,
  WorktreeRemoveResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IWorktreeService {
  /** 按根项目分组的注册工作树概览（含 git 状态对账 + 关联会话）。 */
  list(): Promise<WorktreeListResult>;
  /** 创建 detached 工作树（随机目录名；ref 缺省取远程默认分支）；含自动清理。 */
  create(params: WorktreeCreateInput): Promise<WorktreeRegistryEntry>;
  /** 删除工作树（D1：连同其全部会话历史）；脏树需 force，运行中进程直接拒绝。 */
  remove(params: WorktreeRemoveInput): Promise<WorktreeRemoveResult>;
  /** 更新 lastUsedAt（会话创建/激活时调用，自动清理的最旧排序依据）。 */
  touch(params: { worktreePath: string }): Promise<void>;
}

export const IWorktreeService = createServiceDescriptor<IWorktreeService>(ServiceChannels.Worktree);
