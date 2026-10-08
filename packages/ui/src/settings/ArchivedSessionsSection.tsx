/**
 * 设置 · 已归档会话总览（跨项目）。
 *
 * 数据：zcodeTaskService.listAllArchivedTasks（跨 workspace）+ worktreeService.list
 * （分组与取消归档资格判定）。分组按「根项目」维度——worktree 会话经注册表映射并入
 * 其根项目组（specs/desktop/worktrees.md D3 同源规则）。
 *
 * 操作语义：
 * - 取消归档：worktree 会话仅当其工作树磁盘就绪时可用（工作树被删/缺失时只能删除；
 *   经 Worktrees 页删除工作树时其会话已被彻底删除，不会出现在此列表）；
 *   删除归档会话不影响工作树本身，只 tombstone 会话记录。
 * - 删除：两击确认；deleteArchivedTask 只删除「写入时仍归档」的任务（服务端 guard）。
 * - 项目「更多」菜单 / 右上角「全部删除」：按 workspace 批量 deleteArchivedTasks。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  GitBranch,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorktreeListResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getPathLeaf } from "@/lib/path.js";
import { cn } from "@/components/lib/utils.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { ArchivedTaskRowCard } from "@/settings/ArchivedTaskRowCard.js";
import { worktreeShortId } from "@/store/worktreeStore.js";
import { logger } from "@/logger.js";

interface ArchivedGroup {
  rootWorkspacePath: string;
  repoName: string;
  /** 组内会话（根项目 + 其全部 worktree）。 */
  tasks: ZCodeTaskMeta[];
  latestUpdatedAt: number;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 归档会话 → 根项目路径（worktree 经注册表映射，普通会话即自身 workspace）。 */
function buildGroups(
  tasks: ZCodeTaskMeta[],
  worktreeByPath: Map<string, { rootWorkspacePath: string; diskStatus: string }>,
): ArchivedGroup[] {
  const groupByRoot = new Map<string, ZCodeTaskMeta[]>();
  for (const task of tasks) {
    const worktree = worktreeByPath.get(task.workspacePath);
    const root = worktree?.rootWorkspacePath ?? task.workspacePath;
    const bucket = groupByRoot.get(root);
    if (bucket) {
      bucket.push(task);
    } else {
      groupByRoot.set(root, [task]);
    }
  }
  const groups: ArchivedGroup[] = [];
  for (const [rootWorkspacePath, groupTasks] of groupByRoot) {
    groups.push({
      rootWorkspacePath,
      repoName: getPathLeaf(rootWorkspacePath) || rootWorkspacePath,
      tasks: groupTasks,
      latestUpdatedAt: Math.max(...groupTasks.map((task) => task.updatedAt)),
    });
  }
  groups.sort((left, right) => right.latestUpdatedAt - left.latestUpdatedAt);
  return groups;
}

export function ArchivedSessionsSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const zcodeTaskService = services.zcodeTaskService;
  const worktreeService = services.worktreeService;

  const [tasks, setTasks] = useState<ZCodeTaskMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [worktreeByPath, setWorktreeByPath] = useState<
    Map<string, { rootWorkspacePath: string; diskStatus: string }>
  >(new Map());
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (): Promise<ZCodeTaskMeta[] | null> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const [archived, worktreeList] = await Promise.all([
        zcodeTaskService.listAllArchivedTasks(),
        worktreeService
          ? worktreeService.list().catch(() => null as WorktreeListResult | null)
          : Promise.resolve(null as WorktreeListResult | null),
      ]);
      if (requestIdRef.current !== requestId) {
        return null;
      }
      setTasks(archived);
      const byPath = new Map<string, { rootWorkspacePath: string; diskStatus: string }>();
      for (const group of worktreeList?.groups ?? []) {
        for (const item of group.worktrees) {
          byPath.set(item.entry.worktreePath, {
            rootWorkspacePath: item.entry.rootWorkspacePath,
            diskStatus: item.diskStatus,
          });
        }
      }
      setWorktreeByPath(byPath);
      setLoading(false);
      return archived;
    } catch (err) {
      if (requestIdRef.current !== requestId) {
        return null;
      }
      setError(getErrorMessage(err));
      setLoading(false);
      return null;
    }
  }, [worktreeService, zcodeTaskService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => {
    const source = tasks ?? [];
    const keyword = searchText.trim().toLowerCase();
    const filtered =
      keyword.length === 0
        ? source
        : source.filter((task) => {
            const worktree = worktreeByPath.get(task.workspacePath);
            const repoName = getPathLeaf(worktree?.rootWorkspacePath ?? task.workspacePath);
            return (
              task.title.toLowerCase().includes(keyword) ||
              repoName.toLowerCase().includes(keyword) ||
              task.workspacePath.toLowerCase().includes(keyword)
            );
          });
    return buildGroups(filtered, worktreeByPath);
  }, [searchText, tasks, worktreeByPath]);

  /** worktree 归档会话：工作树缺失/被移除时不可取消归档（只能删除）。 */
  const canUnarchive = useCallback(
    (task: ZCodeTaskMeta) => {
      const worktree = worktreeByPath.get(task.workspacePath);
      if (!worktree) {
        return true;
      }
      return worktree.diskStatus === "ready";
    },
    [worktreeByPath],
  );

  const handleUnarchive = useCallback(
    async (task: ZCodeTaskMeta) => {
      try {
        await zcodeTaskService.unarchiveTask({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        });
        toast(intl.formatMessage({ id: "settings.archived.unarchived" }));
        await refresh();
      } catch (err) {
        logger.warn("[Archived] 取消归档失败", { error: err });
        toast(getErrorMessage(err), { variant: "warning" });
      }
    },
    [intl, refresh, zcodeTaskService],
  );

  /** 删除会话只 tombstone 记录；worktree 会话删除不动工作树本身。 */
  const handleDeleteTask = useCallback(
    async (task: ZCodeTaskMeta) => {
      try {
        const removed = await zcodeTaskService.deleteArchivedTask({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        });
        if (!removed) {
          toast(intl.formatMessage({ id: "settings.archived.deleteSkipped" }), {
            variant: "warning",
          });
        }
        setConfirmDeleteTaskId(null);
        await refresh();
      } catch (err) {
        logger.warn("[Archived] 删除失败", { error: err });
        toast(getErrorMessage(err), { variant: "warning" });
      }
    },
    [intl, refresh, zcodeTaskService],
  );

  /** 批量删除给定任务集合（按 workspace 分组走批量接口；服务端归档 guard 兜底）。 */
  const handleBulkDelete = useCallback(
    async (target: ZCodeTaskMeta[]) => {
      try {
        const idsByWorkspace = new Map<string, ZCodeTaskMeta[]>();
        for (const task of target) {
          const key = `${task.workspaceIdentity?.trim() ?? task.workspacePath}\u0000${task.workspacePath}`;
          const bucket = idsByWorkspace.get(key);
          if (bucket) {
            bucket.push(task);
          } else {
            idsByWorkspace.set(key, [task]);
          }
        }
        let removedCount = 0;
        for (const list of idsByWorkspace.values()) {
          const first = list[0];
          if (!first) {
            continue;
          }
          const result = await zcodeTaskService.deleteArchivedTasks({
            workspacePath: first.workspacePath,
            ...(first.workspaceIdentity ? { workspaceIdentity: first.workspaceIdentity } : {}),
            taskIds: list.map((task) => task.taskId),
          });
          removedCount += result.deletedTaskIds.length;
        }
        toast(intl.formatMessage({ id: "settings.archived.bulkDeleted" }, { count: removedCount }));
        setConfirmDeleteAll(false);
        await refresh();
      } catch (err) {
        logger.warn("[Archived] 批量删除失败", { error: err });
        toast(getErrorMessage(err), { variant: "warning" });
      }
    },
    [intl, refresh, zcodeTaskService],
  );

  const totalArchived = tasks?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.archived.searchPlaceholder" })}
            className="h-8 w-full pl-8"
            spellCheck={false}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          aria-label={intl.formatMessage({ id: "settings.archived.refresh" })}
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
        {totalArchived > 0 ? (
          confirmDeleteAll ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteAll(false)}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleBulkDelete(tasks ?? [])}
              >
                {intl.formatMessage({ id: "settings.archived.confirmDeleteAll" })}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => setConfirmDeleteAll(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "settings.archived.deleteAll" })}
            </Button>
          )
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-ui-sm text-error">
          {error}
        </div>
      ) : null}

      {loading && !tasks ? (
        <div className="flex items-center gap-2 px-1 text-ui-sm text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {intl.formatMessage({ id: "settings.archived.loading" })}
        </div>
      ) : null}

      {tasks && groups.length === 0 && !loading ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle">
          {searchText.trim()
            ? intl.formatMessage({ id: "settings.archived.searchEmpty" })
            : intl.formatMessage({ id: "settings.archived.empty" })}
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.rootWorkspacePath} className="flex flex-col gap-2">
          <SettingsResourceGroupHeader
            title={group.repoName}
            count={group.tasks.length}
            actions={
              <div className="flex items-center gap-2">
                <span
                  className="max-w-[300px] truncate text-ui-sm text-foreground-subtle"
                  title={group.rootWorkspacePath}
                >
                  {group.rootWorkspacePath}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "settings.archived.moreActions" })}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => void handleBulkDelete(group.tasks)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {intl.formatMessage({ id: "settings.archived.deleteProjectAll" })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
          <SettingsResourceList
            items={group.tasks}
            getKey={(task) => `${task.workspacePath}:${task.taskId}`}
            renderItem={(task) => (
              <ArchivedTaskRowCard
                task={task}
                worktreeInfo={worktreeByPath.get(task.workspacePath) ?? null}
                unarchivable={canUnarchive(task)}
                confirmArmed={confirmDeleteTaskId === task.taskId}
                onArmConfirm={() => setConfirmDeleteTaskId(task.taskId)}
                onCancelConfirm={() => setConfirmDeleteTaskId(null)}
                onUnarchive={() => void handleUnarchive(task)}
                onDelete={() => void handleDeleteTask(task)}
              />
            )}
          />
        </div>
      ))}
    </div>
  );
}
