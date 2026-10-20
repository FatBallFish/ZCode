/** One drag payload and pointer-drop registry for split placement and detached-window handoff. */
export * from "../v4/workbenchDragDrop.js";
export { createWorkbenchPointerPositionTracker } from "../v4/workbenchPointerPositionTracker.js";
export type { WorkbenchPointerPositionTracker } from "../v4/workbenchPointerPositionTracker.js";
export {
  cancelWorkbenchPointerDrag,
  finishWorkbenchPointerDrag,
  registerWorkbenchPointerDropTarget,
  updateWorkbenchPointerDrag,
} from "../v4/workbenchPointerDragDrop.js";
export {
  bindSessionWindowOpener,
  trackSessionDragForWindowOpen,
  setWorkbenchDropZoneActive,
  updateSessionPointerDragOutsideViewport,
  finishSessionPointerDragOutsideViewport,
  useSessionWindowDragOutStore,
} from "../v4/workbenchWindowDragOut.js";
