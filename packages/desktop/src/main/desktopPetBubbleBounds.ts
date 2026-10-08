/**
 * 宠物会话气泡的纯定位计算（无 electron 依赖，便于单测）。
 */
export const PET_BUBBLE_WIDTH = 320;
const ROW_HEIGHT = 54;
const OVERFLOW_ROW_HEIGHT = 30;
const HEADER_HEIGHT = 22;
const BUBBLE_MARGIN = 10;
const BUBBLE_PADDING = 12;

/** 折叠态只保留 header 行；窗口高度随之收缩。 */
export function computeBubbleHeight(
  payload: { rows: unknown[]; overflowCount: number },
  collapsed = false,
): number {
  const base = BUBBLE_PADDING * 2 + HEADER_HEIGHT;
  if (collapsed) return base;
  return (
    base + payload.rows.length * ROW_HEIGHT + (payload.overflowCount > 0 ? OVERFLOW_ROW_HEIGHT : 0)
  );
}

/** 宠物正上方水平居中；workArea 夹取，上方放不下放宠物下方。纯函数便于单测。 */
export function computeBubbleBounds(
  petBounds: { x: number; y: number; width: number; height: number },
  bubbleHeight: number,
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(
    Math.max(petBounds.x + Math.round(petBounds.width / 2) - PET_BUBBLE_WIDTH / 2, workArea.x),
    workArea.x + workArea.width - PET_BUBBLE_WIDTH,
  );
  const aboveY = petBounds.y - bubbleHeight - BUBBLE_MARGIN;
  const y =
    aboveY >= workArea.y
      ? aboveY
      : Math.min(
          petBounds.y + petBounds.height + BUBBLE_MARGIN,
          workArea.y + workArea.height - bubbleHeight,
        );
  return { x, y, width: PET_BUBBLE_WIDTH, height: bubbleHeight };
}
