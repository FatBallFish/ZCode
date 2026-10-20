import { trackSessionDragForWindowOpen, type WorkbenchSessionDragPayload } from "./contract.js";
/** The existing window opener is bound at the app root; this lifecycle returns one cleanup handle. */
export function beginScopedSessionDrag(
  payload: WorkbenchSessionDragPayload,
  sourceRow: Element,
): () => void {
  return trackSessionDragForWindowOpen(payload, sourceRow);
}
