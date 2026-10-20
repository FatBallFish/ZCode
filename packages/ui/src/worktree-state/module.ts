export const worktreeUiStateModule = {
  id: "worktree-ui-state",
  requires: ["services", "shared", "ui"],
  provides: ["worktree-ui-state"],
  publicEntrypoints: ["index.ts", "contract.ts", "../store/worktreeStore.ts"],
} as const;
