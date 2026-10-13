/**
 * 会话拖出侧栏 → 独立会话窗口打开（specs/desktop/session-drag-out-window.md）。
 *
 * 交互语义（2026-10-14 按用户反馈重做，文案与行为严格同源——同一谓词决定 chip
 * 展示与释放动作，不存在「显示文案却不开窗 / 未显示文案却开窗」）：
 * - 释放在任何 pane 的边缘分屏区 → 走既有 workbench 分屏/叠放（dropEffect 已被消费）；
 * - 指针仍在「所属范围」内（项目视图 = 所属项目行+其会话列表块；置顶分区 = 置顶区块）
 *   → 取消（拖回原地），无 chip；
 * - 指针超出所属范围（其他项目区/展示页/标题栏/窗口外）→ 打开会话窗口，chip 展示。
 *
 * 实现说明：
 * - HTML5 DnD 指针离开应用窗口后不再派发 dragover、也读不到最终落点，用
 *   「dragover 停止更新超阈值」判定出窗；期间用节拍器把提示切成 new-window，
 *   保证「拖出窗口外 → chip 仍在（冻结于最后位置）→ 释放开窗」的链路一致。
 * - tracker 单例：源行在虚拟列表重渲中被卸载时 dragend 不会派发，残留的 window
 *   监听会让下一次拖放触发两次开窗（用户实测双开）。每次 dragStart 先释放旧 tracker。
 */
import { create } from "zustand";
import { logger } from "@/logger.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";

/** dragover 停止更新超过该窗口即认为指针已离开应用窗口。 */
const DRAG_OVER_STALE_MS = 300;
/** stale 检测节拍（略快于 STALE_MS，保证出窗后 ~400ms 内提示就位）。 */
const HEARTBEAT_MS = 120;

interface SessionWindowDragOutState {
  /** 一次会话拖拽进行中（仅本地 workspace 且桌面端有 opener 时置位）。 */
  active: boolean;
  /** 当前引导态：new-window = 显示「松开以在新窗口打开会话」chip；null = 无引导。 */
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

// ── 分屏高亮区活动登记（WorkbenchPane 上报，用于命中分屏区时隐藏新窗口引导）──
const activeDropZonePaneIds = new Set<string>();

export function setWorkbenchDropZoneActive(paneId: string, active: boolean): void {
  if (active) {
    activeDropZonePaneIds.add(paneId);
  } else {
    activeDropZonePaneIds.delete(paneId);
  }
}

function isInsideRect(rect: DOMRect | undefined, x: number, y: number): boolean {
  if (!rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** 活动 tracker 的清理句柄（模块级单例，见文件头注释）。 */
let disposeActiveTracker: (() => void) | null = null;

/**
 * 为一次 HTML5 会话拖拽挂接「拖出开窗」追踪。
 * @param sourceElement 拖拽源行元素——所属范围从它向上找 `[data-session-drag-owner-scope]`
 *   （项目行/置顶分区），找不到时回退整个侧栏（拖动未离开侧栏 = 取消）。
 */
export function trackSessionDragForWindowOpen(
  payload: WorkbenchSessionDragPayload,
  sourceElement?: Element,
): () => void {
  disposeActiveTracker?.();
  disposeActiveTracker = null;
  if (!sessionWindowOpener || payload.remoteSessionId) {
    // 远程会话的独立窗口承载暂不开放（main 同样拒绝）。
    return () => {};
  }

  let disposed = false;
  let lastDragOverAt = Date.now();
  let insideOwner = true;
  let pointerX = 0;
  let pointerY = 0;

  const ownerElement =
    sourceElement?.closest<HTMLElement>("[data-session-drag-owner-scope]") ??
    sourceElement?.closest<HTMLElement>('[data-testid="sidebar"]') ??
    null;

  const syncIndicator = () => {
    const mode: "new-window" | null =
      !insideOwner && activeDropZonePaneIds.size === 0 ? "new-window" : null;
    useSessionWindowDragOutStore.setState({ active: true, mode, pointerX, pointerY });
  };

  const onDragOver = (event: DragEvent) => {
    lastDragOverAt = Date.now();
    pointerX = event.clientX;
    pointerY = event.clientY;
    insideOwner = isInsideRect(ownerElement?.getBoundingClientRect(), pointerX, pointerY);
    syncIndicator();
  };

  const heartbeat = window.setInterval(() => {
    if (disposed) return;
    if (Date.now() - lastDragOverAt > DRAG_OVER_STALE_MS && insideOwner) {
      // 指针已离开应用窗口：必然超出所属范围，提示切换为 new-window（位置冻结在
      // 最后一次 dragover，chip 保持可见）。
      insideOwner = false;
      syncIndicator();
    }
  }, HEARTBEAT_MS);

  const onDragEnd = (event: DragEvent) => {
    const dropEffect = event.dataTransfer?.dropEffect;
    const consumed = dropEffect === "copy" || dropEffect === "move";
    const outsideWindow = Date.now() - lastDragOverAt > DRAG_OVER_STALE_MS;
    dispose();
    if (consumed) {
      // 已被 pane drop 目标消费（分屏/叠放）。
      return;
    }
    if (insideOwner && !outsideWindow) {
      // 所属范围内释放：取消（与无 chip 的提示一致）。
      return;
    }
    void openSessionWindow(payload);
  };

  const onDrop = () => {
    // drop 被 pane 消费时同样收尾（dragend 随后触发会直接走 disposed 分支）。
    dispose();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(heartbeat);
    window.removeEventListener("dragover", onDragOver, true);
    window.removeEventListener("dragend", onDragEnd);
    window.removeEventListener("drop", onDrop, true);
    if (disposeActiveTracker === dispose) {
      disposeActiveTracker = null;
    }
    useSessionWindowDragOutStore.setState({ active: false, mode: null });
  };

  disposeActiveTracker = dispose;
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragend", onDragEnd);
  window.addEventListener("drop", onDrop, true);
  syncIndicator();
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

/** 指针拖拽释放：未命中任何 pane 且指针在窗口外 → 会话窗口打开；返回是否已消费。 */
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
