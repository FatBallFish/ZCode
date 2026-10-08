import type { WindowHostControllerTaskRow } from "./zcode-protocol-v4/index.js";
import type { PetSessionSummary } from "./pets.js";

/**
 * 宠物会话摘要纯逻辑（specs/desktop/desktop-pet.md 会话状态气泡）：
 * host 侧把 Controller 投影行过滤映射为气泡摘要；main 侧把多 host 摘要合并去重。
 *
 * 过滤：running/waiting 全保留；completed/error 在未读或终态宽限期内保留
 * （overlay 会话结束→meta 落库之间有瞬态 idle；且未读标记由主窗口 renderer 写入，
 * 窗口被关闭时无人写 unreadAt——宽限期保证用户至少看到完成的终态反馈）；idle 不进气泡。
 * 排序：waiting > running > error(未读) > completed(未读)，同级按 updatedAt 降序。
 */

/** 终态宽限期：完成后无论是否已读，气泡行至少展示这么久（✓/✕ 终态反馈）。 */
export const PET_TERMINAL_GRACE_MS = 120_000;

/** 会话行的稳定键（与 merge 去重同款）：关闭/清空终态行的 dismissed 集合用它。 */
export function petTaskKey(summary: {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return `${summary.workspaceIdentity?.trim() || summary.workspacePath}\0${summary.taskId}`;
}

/** 气泡可见行上限（merge 层裁剪，host 各自全量上报）。 */
export const PET_BUBBLE_MAX_ROWS = 6;

const STATUS_PRIORITY: Record<PetSessionSummary["liveStatus"], number> = {
  waiting: 0,
  running: 1,
  error: 2,
  completed: 3,
};

/** 行 → 单条摘要；pendingKind 优先持久化 meta，缺省从 activity 计数推导（permission 优先）。 */
function rowPending(row: WindowHostControllerTaskRow): {
  kind?: "permission" | "userInput";
  toolName?: string;
} {
  if (row.meta.pendingInteraction) {
    return {
      kind: row.meta.pendingInteraction.kind,
      ...(row.meta.pendingInteraction.toolName
        ? { toolName: row.meta.pendingInteraction.toolName }
        : {}),
    };
  }
  const counts = row.activity?.pendingInteractions;
  if (counts && counts.permissionCount > 0) return { kind: "permission" };
  if (counts && counts.userInputCount > 0) return { kind: "userInput" };
  return {};
}

export function mapRowsToPetSummaries(
  rows: readonly WindowHostControllerTaskRow[],
  nowMs: number = Date.now(),
): (PetSessionSummary & { updatedAt: number })[] {
  const mapped = rows
    .filter((row) => {
      if (row.liveStatus === "running" || row.liveStatus === "waiting") return true;
      if (row.liveStatus === "completed" || row.liveStatus === "error") {
        return (
          row.meta.unreadAt != null || nowMs - (row.meta.updatedAt ?? 0) < PET_TERMINAL_GRACE_MS
        );
      }
      return false;
    })
    .map((row): PetSessionSummary & { updatedAt: number } => {
      const pending = row.liveStatus === "waiting" ? rowPending(row) : {};
      return {
        taskId: row.address.taskId,
        workspacePath: row.address.workspacePath,
        ...(row.address.workspaceIdentity
          ? { workspaceIdentity: row.address.workspaceIdentity }
          : {}),
        title: row.meta.title || row.address.taskId,
        liveStatus: row.liveStatus as PetSessionSummary["liveStatus"],
        ...(row.activity?.lastAssistantPreview
          ? { lastPreview: row.activity.lastAssistantPreview }
          : {}),
        unread: row.meta.unreadAt != null,
        ...(pending.kind ? { pendingKind: pending.kind } : {}),
        ...(pending.toolName ? { pendingToolName: pending.toolName } : {}),
        updatedAt: row.activity?.lastActivityAt ?? row.meta.updatedAt ?? 0,
      };
    })
    .sort(
      (left, right) =>
        STATUS_PRIORITY[left.liveStatus] - STATUS_PRIORITY[right.liveStatus] ||
        right.updatedAt - left.updatedAt ||
        left.taskId.localeCompare(right.taskId),
    );
  return mapped;
}

/** main 侧多 host 合并：taskKey 去重（后到的 host 覆盖），重排序后裁剪到气泡上限。 */
export function mergePetSessionSummaries(perHost: readonly (readonly PetSessionSummary[])[]): {
  rows: PetSessionSummary[];
  overflowCount: number;
} {
  const byKey = new Map<string, PetSessionSummary>();
  for (const summaries of perHost) {
    for (const summary of summaries) {
      byKey.set(
        `${summary.workspaceIdentity?.trim() || summary.workspacePath}\0${summary.taskId}`,
        summary,
      );
    }
  }
  const sorted = [...byKey.values()].sort(
    (left, right) =>
      STATUS_PRIORITY[left.liveStatus] - STATUS_PRIORITY[right.liveStatus] ||
      left.taskId.localeCompare(right.taskId),
  );
  return {
    rows: sorted.slice(0, PET_BUBBLE_MAX_ROWS),
    overflowCount: Math.max(0, sorted.length - PET_BUBBLE_MAX_ROWS),
  };
}
