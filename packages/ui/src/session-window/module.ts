export const sessionWindowUiModule = {
  id: "session-window-ui",
  requires: ["services", "shared", "ui", "worktree-ui-state"],
  provides: ["session-window-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "../SessionWindowRoot.tsx"],
} as const;
