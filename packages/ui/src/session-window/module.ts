export const sessionWindowUiModule = {
  id: "session-window-ui",
  requires: ["services", "shared", "ui", "worktree-ui-state", "plugin-ui"],
  provides: ["session-window-ui"],
  publicEntrypoints: ["index.ts", "contract.ts", "../SessionWindowRoot.tsx"],
} as const;
