import { useWorktreeStore } from "./index.js";
/** 首发由原有 Composer admission 读取并消费意图，切换草稿自身不创建工作树。 */
export function selectIsolatedDraft(rootWorkspaceKey: string, ref: string): void {
  useWorktreeStore.getState().setDraftLocation(rootWorkspaceKey, { mode: "new-worktree", ref });
}
