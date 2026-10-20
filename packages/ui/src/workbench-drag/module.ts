export const workbenchDragModule = {
  id: "workbench-drag",
  requires: ["ui"],
  provides: ["workbench-drag"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "../v4/workbenchDragDrop.ts",
    "../v4/workbenchPointerDragDrop.ts",
    "../v4/workbenchPointerPositionTracker.ts",
    "../v4/workbenchWindowDragOut.ts",
  ],
} as const;
