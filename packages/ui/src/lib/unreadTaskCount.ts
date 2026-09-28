import { getVisibleTaskMetas } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";

type WorkspaceUnreadState = Pick<
  WorkspaceZCodeUIState,
  "optimisticTaskListByTaskId" | "taskListCache"
> &
  Partial<Pick<WorkspaceZCodeUIState, "taskUnreadByTaskId">>;

export function countAllUnreadTasks(workspaces: Record<string, WorkspaceUnreadState>): number {
  const countedTaskKeys = new Set<string>();
  const visitedWorkspaceStates = new WeakSet<object>();

  for (const [workspaceKey, workspace] of Object.entries(workspaces)) {
    if (visitedWorkspaceStates.has(workspace)) {
      continue;
    }
    visitedWorkspaceStates.add(workspace);
    // 未读状态现在统一以 task meta.unreadAt 为准。
    // Dock badge 必须和任务列表蓝点读取同一份元数据，不能再单独依赖旧的临时 map。
    const visibleTasks = getVisibleTaskMetas(workspace);
    for (const task of visibleTasks) {
      if (!task.unreadAt) {
        continue;
      }
      countedTaskKeys.add(
        `${task.workspaceIdentity?.trim() || task.workspacePath}::${task.taskId}`,
      );
    }

    if (visibleTasks.length > 0) {
      continue;
    }

    // remote workspace 会同时保留 path key 和 workspaceIdentity key 的兼容状态
    // （identity 桶由 path 桶一次性迁移种子派生，未读 map 会双份）。
    // 去重键必须与主分支同一归一规则：优先取任务 meta 自带的 workspaceIdentity，
    // 取不到才退 workspaceKey——此前直接用 workspaceKey，同一远端 task 在两个桶
    // 里各计一次（2026-09-28 Dock badge 82 排障定位的重复计数根因）。
    for (const taskId of Object.keys(workspace.taskUnreadByTaskId ?? {})) {
      const identity =
        workspace.optimisticTaskListByTaskId?.[taskId]?.workspaceIdentity?.trim() ||
        workspace.taskListCache?.find((task) => task.taskId === taskId)?.workspaceIdentity?.trim();
      countedTaskKeys.add(`${identity || workspaceKey}::${taskId}`);
    }
  }

  return countedTaskKeys.size;
}
