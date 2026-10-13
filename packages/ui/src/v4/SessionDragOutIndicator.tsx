/**
 * 会话拖出侧栏的「松开以在新窗口打开」引导 chip（specs/desktop/session-drag-out-window.md）。
 * 仅在拖拽进行中且当前落点属于「新建窗口」区域时出现；跟随指针、pointer-events none。
 */
import { memo } from "react";
import { AppWindow } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSessionWindowDragOutStore } from "@/v4/workbenchWindowDragOut.js";

export const SessionDragOutIndicator = memo(function SessionDragOutIndicator() {
  const { intl } = useZCodeIntl();
  const active = useSessionWindowDragOutStore((state) => state.active);
  const mode = useSessionWindowDragOutStore((state) => state.mode);
  const pointerX = useSessionWindowDragOutStore((state) => state.pointerX);
  const pointerY = useSessionWindowDragOutStore((state) => state.pointerY);

  if (!active || mode !== "new-window") {
    return null;
  }

  const left = Math.min(pointerX + 18, Math.max(window.innerWidth - 260, 12));
  const top = Math.min(pointerY + 18, Math.max(window.innerHeight - 56, 12));

  return (
    <div
      data-testid="session-drag-out-indicator"
      aria-hidden="true"
      className="pointer-events-none fixed z-[70] flex items-center gap-2 rounded-lg border border-border
        bg-bg-elevated px-3 py-1.5 text-ui-sm text-foreground shadow-lg"
      style={{ left, top }}
    >
      <AppWindow className="size-4 shrink-0 text-brand" aria-hidden="true" />
      <span>{intl.formatMessage({ id: "workbench.dragOut.newWindowHint" })}</span>
    </div>
  );
});
