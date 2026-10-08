/**
 * Worktree 渲染层状态（specs/desktop/worktrees.md）。
 *
 * 三个切片，真值归属各不相同：
 * - registry：host WorktreeService 的只读缓存（不作为真值；加载点收敛于
 *   App 挂载、设置页打开、创建/删除 RPC 返回后）。
 * - draftLocation：草稿「工作位置」选项，按根 workspaceKey 存放；会话真正
 *   发起后即失效（消费方负责清理）。
 * 首条消息不在本层投递：重定向时直接经 createSession.firstInput 原子建会话
 * （specs/desktop/worktrees.md；曾用 pane 挂载 effect 投递，重挂载会重复建会话，已移除）。
 */
import { create } from "zustand";
import type { IWorktreeService } from "@zcode/services";
import type { WorktreeRegistryEntry } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";

export type DraftWorkLocationMode = "local" | "new-worktree" | "existing-worktree";

export interface DraftWorkLocation {
  mode: DraftWorkLocationMode;
  /** new-worktree：起始分支；缺省由服务端取远程默认分支。 */
  ref?: string;
  /** existing-worktree：目标工作树路径。 */
  worktreePath?: string;
  /** /new 等场景锁定（chip 不可交互，仅展示）。 */
  locked?: boolean;
}

/** 展示短 id：8 位目录名取前 4 位（对齐 Codex「036b」风格）。 */
export function worktreeShortId(idOrPath: string): string {
  const leaf = idOrPath.split(/[\\/]/).at(-1) ?? idOrPath;
  return leaf.slice(0, 4);
}

/** worktree workspace 的展示名：「repoName · 短id」。 */
export function formatWorktreeWorkspaceLabel(worktreePath: string, rootPath: string): string {
  const entry = resolveWorktreeEntryForPath(worktreePath);
  const shortId = entry ? worktreeShortId(entry.id) : worktreeShortId(worktreePath);
  const repoName = entry
    ? getPathLeaf(entry.rootWorkspacePath) || getPathLeaf(rootPath)
    : getPathLeaf(rootPath);
  return `${repoName} · ${shortId}`;
}

interface WorktreeStoreState {
  registryEntries: WorktreeRegistryEntry[];
  registryLoadedAt: number | null;
  registryLoading: boolean;
  refreshRegistry: (service: IWorktreeService | undefined) => Promise<void>;

  draftLocationByRootKey: Record<string, DraftWorkLocation>;
  setDraftLocation: (rootKey: string, location: DraftWorkLocation | null) => void;
  getDraftLocation: (rootKey: string) => DraftWorkLocation;
}

/** 草稿工作位置的缺省值；必须保持稳定引用（zustand selector fallback）。 */
export const DEFAULT_DRAFT_LOCATION: DraftWorkLocation = { mode: "local" };

let registryCache: WorktreeRegistryEntry[] = [];
let registryRequestId = 0;

function resolveWorktreeEntryForPath(path: string): WorktreeRegistryEntry | undefined {
  return registryCache.find((entry) => entry.worktreePath === path);
}

export const useWorktreeStore = create<WorktreeStoreState>((set, get) => ({
  registryEntries: [],
  registryLoadedAt: null,
  registryLoading: false,

  async refreshRegistry(service) {
    if (!service) {
      return;
    }
    // request-id 防竞态：旧请求晚到不得覆盖新数据（MemorySettings 先例）。
    const requestId = ++registryRequestId;
    if (!get().registryLoading) {
      set({ registryLoading: true });
    }
    try {
      const entries = await service
        .list()
        .then((result) =>
          result.groups.flatMap((group) => group.worktrees.map((item) => item.entry)),
        )
        .catch(() => [] as WorktreeRegistryEntry[]);
      if (requestId !== registryRequestId) {
        return;
      }
      registryCache = entries;
      set({
        registryEntries: entries,
        registryLoadedAt: Date.now(),
        registryLoading: false,
      });
    } catch {
      if (requestId === registryRequestId) {
        set({ registryLoading: false });
      }
    }
  },

  draftLocationByRootKey: {},

  setDraftLocation(rootKey, location) {
    set((state) => {
      const next = { ...state.draftLocationByRootKey };
      if (location) {
        next[rootKey] = location;
      } else {
        delete next[rootKey];
      }
      return { draftLocationByRootKey: next };
    });
  },

  getDraftLocation(rootKey) {
    return get().draftLocationByRootKey[rootKey] ?? DEFAULT_DRAFT_LOCATION;
  },
}));

/** 注册表快照查询（非响应式；用于一次性判断）。 */
export function getWorktreeRegistrySnapshot(): WorktreeRegistryEntry[] {
  return registryCache;
}

/** 某路径是否是注册的 worktree workspace。 */
export function isRegisteredWorktreePath(path: string): boolean {
  return registryCache.some((entry) => entry.worktreePath === path);
}

/** 根项目的全部注册工作树。 */
export function getWorktreesForRoot(rootWorkspacePath: string): WorktreeRegistryEntry[] {
  return registryCache.filter((entry) => entry.rootWorkspacePath === rootWorkspacePath);
}
