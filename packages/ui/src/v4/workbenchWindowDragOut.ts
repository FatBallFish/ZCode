/**
 * 会话拖出侧栏 → 独立新窗口打开（specs/desktop/session-drag-out-window.md）。
 *
 * 交互语义（三分支，与既有分屏拖放并存）：
 * - 落在会话展示页的 pane 边缘分屏区 → 走既有 workbench 分屏/叠放（本模块不介入）；
 * - 落在会话展示页中部（无分屏区）→ 无效果；
 * - 落在侧栏以外的非展示区（标题栏等），或释放时指针已在窗口外（dragover 停止
 *   更新超过阈值）→ 在新主窗口打开该会话。
 *
 * 实现说明：HTML5 DnD 在指针离开窗口后不再派发 dragover，也无法读取最终落点坐标，
 * 因此「窗口外释放」用「dragover 停止更新 + dragend 未被任何 drop 目标消费
 * （dropEffect 仍为 none）」推断；侧栏内释放视为取消（拖回原地）。
 */
import { create } from "zustand";
import { logger } from "@/logger.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";

/** dragover 停止更新超过该窗口即认为指针已离开应用窗口。 */
const DRAG_OVER_STALE_MS = 300;

interface SessionWindowDragOutState {
  /** 一次会话拖拽进行中（仅本地 workspace 且桌面端有 opener 时置位）。 */
  active: boolean;
  /** 当前引导态：new-window = 显示「松开以在新窗口打开」chip；null = 无引导。 */
  mode: "new-window" | null;
  pointerX: number;
  pointerY: number;
}

export const useSessionWindowDragOutStore = create<SessionWindowDragOutState>(() => ({
  active: false,
  mode: null,
  pointerX: 0,
  pointerY: 0,
}));

type SessionWindowOpener = (payload: WorkbenchSessionDragPayload) => Promise<void>;

let sessionWindowOpener: SessionWindowOpener | null = null;

/** App 根部用当前 platform 绑定（Web/手机远控不绑定 → 拖出新窗口自动禁用）。 */
export function bindSessionWindowOpener(opener: SessionWindowOpener | null): void {
  sessionWindowOpener = opener;
}

async function openSessionWindow(payload: WorkbenchSessionDragPayload): Promise<void> {
  const opener = sessionWindowOpener;
  if (!opener) return;
  try {
    await opener(payload);
  } catch (error) {
    logger.warn("open session in new window failed", { error: String(error) });
  }
}

// ── 分屏高亮区活动登记（WorkbenchPane 上报，用于隐藏新窗口引导）──
const activeDropZonePaneIds = new Set<string>();

export function setWorkbenchDropZoneActive(paneId: string, active: boolean): void {
  if (active) {
    activeDropZonePaneIds.add(paneId);
  } else {
    activeDropZonePaneIds.delete(paneId);
  }
}

type SessionDragRegion = "sidebar" | "workbench" | "other";

function resolveSessionDragRegion(x: number, y: number): SessionDragRegion {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof Element)) {
    return "other";
  }
  if (element.closest('[data-testid="sidebar"]')) {
    return "sidebar";
  }
  if (element.closest("[data-workbench-display-root]")) {
    return "workbench";
  }
  return "other";
}

/**
 * 为一次 HTML5 会话拖拽挂接「拖出新窗口」追踪；返回清理函数（dragend 时自清理）。
 * 判定不改变既有 dataTransfer 语义：pane 的 dragover/drop 照常工作，本模块只在
 * dragend「无人消费」时兜底。
 */
export function trackSessionDragForWindowOpen(payload: WorkbenchSessionDragPayload): () => void {
  if (!sessionWindowOpener) {
    return () => {};
  }
  if (payload.remoteSessionId) {
    // 远程会话的新窗口承载（连接复用/远端 runtime 归属）暂不开放（main 同样拒绝）。
    return () => {};
  }

  let disposed = false;
  let lastDragOverAt = 0;
  let lastRegion: SessionDragRegion = "other";

  const onDragOver = (event: DragEvent) => {
    lastDragOverAt = Date.now();
    lastRegion = resolveSessionDragRegion(event.clientX, event.clientY);
    const mode: "new-window" | null =
      lastRegion === "other" && activeDropZonePaneIds.size === 0 ? "new-window" : null;
    useSessionWindowDragOutStore.setState({
      active: true,
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
    });
  };

  const onDragEnd = (event: DragEvent) => {
    dispose();
    const dropEffect = event.dataTransfer?.dropEffect;
    if (dropEffect === "copy" || dropEffect === "move") {
      // 已被 pane drop 目标消费（分屏/叠放），不做任何事。
      return;
    }
    const stale = Date.now() - lastDragOverAt > DRAG_OVER_STALE_MS;
    if (stale || lastRegion === "other") {
      void openSessionWindow(payload);
    }
    // sidebar → 取消；workbench 中部 → 无效果。
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("dragover", onDragOver, true);
    window.removeEventListener("dragend", onDragEnd);
    useSessionWindowDragOutStore.setState({ active: false, mode: null });
  };

  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragend", onDragEnd);
  useSessionWindowDragOutStore.setState({ active: true, mode: null });
  return dispose;
}

/** 指针拖拽通道（分组视图 dnd-kit）在指针移出窗口时的引导更新。 */
export function updateSessionPointerDragOutsideViewport(
  payload: WorkbenchSessionDragPayload | null,
  x: number,
  y: number,
): void {
  if (!payload || !sessionWindowOpener || payload.remoteSessionId) return;
  const outside = x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;
  useSessionWindowDragOutStore.setState({
    active: outside,
    mode: outside ? "new-window" : null,
    pointerX: x,
    pointerY: y,
  });
}

/** 指针拖拽释放：未命中任何 pane 且指针在窗口外 → 新窗口打开；返回是否已消费。 */
export function finishSessionPointerDragOutsideViewport(
  payload: WorkbenchSessionDragPayload | null,
  x: number,
  y: number,
): boolean {
  const wasOutside = useSessionWindowDragOutStore.getState().mode === "new-window";
  useSessionWindowDragOutStore.setState({ active: false, mode: null });
  if (!payload || !wasOutside) return false;
  if (payload.remoteSessionId) return false;
  void openSessionWindow(payload);
  return true;
}
