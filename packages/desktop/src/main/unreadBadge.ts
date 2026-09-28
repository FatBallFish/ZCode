type AppBadgeSetter = (count: number) => void;

export function parseWindowUnreadCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isInteger(payload) || payload < 0) {
    return null;
  }

  return payload;
}

/**
 * 窗口未读求和（2026-09-28 语义修订）：每个窗口上报的都是「其可见 workspace 集合内
 * 的全局未读总数」——workspace 集合相同的多个窗口共享同一批任务数据，直接求和会把
 * 同一批未读按窗口数翻倍。相同集合（排序后签名一致）的窗口只计一次（取最大值，
 * 覆盖集合相同但计数瞬时不一致的竞态）；未上报集合的窗口按窗口独立计。
 */
export function sumWindowUnreadCounts(
  windowUnreadCountMap: ReadonlyMap<number, number>,
  windowWorkspaceMap?: ReadonlyMap<number, ReadonlySet<string>>,
): number {
  const maxByScope = new Map<string, number>();

  for (const [windowId, unreadCount] of windowUnreadCountMap) {
    const workspaces = windowWorkspaceMap?.get(windowId);
    const scopeKey =
      workspaces && workspaces.size > 0 ? [...workspaces].sort().join("\n") : `window:${windowId}`;
    maxByScope.set(scopeKey, Math.max(maxByScope.get(scopeKey) ?? 0, unreadCount));
  }

  let totalUnreadCount = 0;
  for (const unreadCount of maxByScope.values()) {
    totalUnreadCount += unreadCount;
  }

  return totalUnreadCount;
}

function supportsAppUnreadBadge(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export function syncAppUnreadBadge(options: {
  platform: NodeJS.Platform;
  totalUnreadCount: number;
  setBadgeCount: AppBadgeSetter;
}): void {
  if (!supportsAppUnreadBadge(options.platform)) {
    return;
  }

  options.setBadgeCount(options.totalUnreadCount);
}
