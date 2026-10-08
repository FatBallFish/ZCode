import { useMemo } from "react";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useWorktreeStore } from "@/store/worktreeStore.js";

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  return !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity;
}

export function useLocalWorkspaceScopes({
  workspaceTabs,
}: {
  workspaceTabs: WorkspaceTabState[];
}): WorkspaceTabState[] {
  // D3 并入：本地根项目在列时，其注册工作树作为虚拟 scope 一并纳入查询面，
  // 让 timeline / 置顶 / 自定义分组视图都能看到 worktree 会话（specs/desktop/worktrees.md）。
  // 虚拟 tab 仅用于构建查询 scope 与展示名回退，绝不进入 tabStore。
  const worktreeRegistryEntries = useWorktreeStore((state) => state.registryEntries);
  return useMemo(() => {
    const localTabs = workspaceTabs.filter(
      (tab) => isWorkspaceTab(tab) && isLocalWorkspaceTab(tab),
    );
    const existingPaths = new Set(localTabs.map((tab) => tab.workspacePath));
    const virtualTabs: WorkspaceTabState[] = [];
    for (const entry of worktreeRegistryEntries) {
      if (existingPaths.has(entry.worktreePath)) {
        continue;
      }
      // 仅当根项目在当前 scope 内才并入其工作树；根项目未打开时不注入。
      if (!localTabs.some((tab) => tab.workspacePath === entry.rootWorkspacePath)) {
        continue;
      }
      existingPaths.add(entry.worktreePath);
      virtualTabs.push({
        kind: "workspace",
        id: `worktree-scope:${entry.worktreePath}`,
        workspacePath: entry.worktreePath,
        label: entry.id.slice(0, 4),
        workspacePurpose: "project",
      });
    }
    return [...localTabs, ...virtualTabs];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅依赖 tabs 与注册表快照
  }, [workspaceTabs, worktreeRegistryEntries]);
}
