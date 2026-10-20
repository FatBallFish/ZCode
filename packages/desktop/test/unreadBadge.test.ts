import { describe, expect, it, vi } from "vitest";
import {
  maxWindowUnreadCounts,
  aggregateWindowUnreadTasks,
  parseWindowUnreadSnapshot,
  sumWindowUnreadCounts,
  parseWindowUnreadCount,
  resolveBadgeOverlayLabel,
  supportsAppUnreadBadge,
  syncUnreadBadgeForPlatform,
} from "../src/main/unreadBadge.js";

describe("unread badge", () => {
  it("只接受非负整数的窗口未读数上报", () => {
    expect(parseWindowUnreadCount(0)).toBe(0);
    expect(parseWindowUnreadCount(3)).toBe(3);
    expect(parseWindowUnreadCount(-1)).toBeNull();
    expect(parseWindowUnreadCount(1.5)).toBeNull();
    expect(parseWindowUnreadCount("2")).toBeNull();
  });

  it("多窗口上报同一全局计数，聚合取 max 防止多主窗口翻倍", () => {
    expect(
      maxWindowUnreadCounts(
        new Map([
          [1, 3],
          [2, 3],
          [3, 0],
        ]),
      ),
    ).toBe(3);
    expect(maxWindowUnreadCounts(new Map())).toBe(0);
  });

  it("相同 workspace 集合的多个窗口只计一次（badge 翻倍修复）", () => {
    const counts = new Map<number, number>([
      [1, 41],
      [2, 41],
    ]);
    const workspaces = new Map<number, ReadonlySet<string>>([
      [1, new Set(["/a", "/b"])],
      [2, new Set(["/b", "/a"])],
    ]);
    expect(sumWindowUnreadCounts(counts, workspaces)).toBe(41);
  });

  it("不同集合的窗口仍求和", () => {
    const counts = new Map<number, number>([
      [1, 3],
      [2, 5],
    ]);
    const workspaces = new Map<number, ReadonlySet<string>>([
      [1, new Set(["/a"])],
      [2, new Set(["/b"])],
    ]);
    expect(sumWindowUnreadCounts(counts, workspaces)).toBe(8);
  });

  it("未上报集合的窗口按窗口独立计", () => {
    const counts = new Map<number, number>([
      [1, 2],
      [2, 3],
    ]);
    expect(sumWindowUnreadCounts(counts)).toBe(5);
    expect(sumWindowUnreadCounts(counts, new Map())).toBe(5);
  });

  it("空集合（窗口尚未上报 workspace）视为独立 scope", () => {
    const counts = new Map<number, number>([
      [1, 2],
      [2, 2],
    ]);
    const workspaces = new Map<number, ReadonlySet<string>>([[1, new Set()]]);
    expect(sumWindowUnreadCounts(counts, workspaces)).toBe(4);
  });

  it("主窗口和独立会话窗均上报全局树计数，窗口作用域不应再次累加", () => {
    expect(
      maxWindowUnreadCounts(
        new Map([
          [1, 41],
          [2, 41],
        ]),
      ),
    ).toBe(41);
    expect(
      maxWindowUnreadCounts(
        new Map([
          [1, 3],
          [2, 5],
        ]),
      ),
    ).toBe(5);
  });

  it("只在 macOS / Linux 启用应用级 badge", () => {
    expect(supportsAppUnreadBadge("darwin")).toBe(true);
    expect(supportsAppUnreadBadge("linux")).toBe(true);
    expect(supportsAppUnreadBadge("win32")).toBe(false);
  });

  it("角标 overlay 文案：0 清除、1~9 原样、10 以上折叠为 9+", () => {
    expect(resolveBadgeOverlayLabel(0)).toBeNull();
    expect(resolveBadgeOverlayLabel(7)).toBe("7");
    expect(resolveBadgeOverlayLabel(9)).toBe("9");
    expect(resolveBadgeOverlayLabel(10)).toBe("9+");
    expect(resolveBadgeOverlayLabel(999)).toBe("9+");
    expect(resolveBadgeOverlayLabel(-3)).toBeNull();
  });

  it("平台分叉：macOS/Linux 写 app badge，不碰 overlay", () => {
    const setBadgeCount = vi.fn();
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "darwin",
      totalUnreadCount: 4,
      setBadgeCount,
      applyOverlay,
    });

    expect(setBadgeCount).toHaveBeenCalledWith(4);
    expect(applyOverlay).not.toHaveBeenCalled();
  });

  it("平台分叉：Windows 写 overlay 文案，不碰 app badge", () => {
    const setBadgeCount = vi.fn();
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "win32",
      totalUnreadCount: 3,
      setBadgeCount,
      applyOverlay,
    });

    expect(applyOverlay).toHaveBeenCalledWith("3");
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it("Windows 未读归零时下发 null 以移除 overlay", () => {
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "win32",
      totalUnreadCount: 0,
      setBadgeCount: vi.fn(),
      applyOverlay,
    });

    expect(applyOverlay).toHaveBeenCalledWith(null);
  });
});

describe("window task identity snapshots", () => {
  it("严格校验计数与身份集合并兼容旧数字", () => {
    expect(parseWindowUnreadSnapshot(3)).toEqual({ count: 3 });
    expect(parseWindowUnreadSnapshot({ count: 2, taskKeys: ["a", "b"] })).toEqual({
      count: 2,
      taskKeys: ["a", "b"],
    });
    for (const value of [
      { count: 2, taskKeys: ["a"] },
      { count: 2, taskKeys: ["a", "a"] },
      { count: 1, taskKeys: [""] },
      { count: -1 },
      null,
    ]) {
      expect(parseWindowUnreadSnapshot(value)).toBeNull();
    }
  });
  it("不同可见集合部分重叠时按任务取并集，不按数字猜测", () => {
    const counts = new Map([
      [1, 2],
      [2, 2],
    ]);
    const keys = new Map([
      [1, new Set(["host-a:/a:1", "host-a:/a:2"])],
      [2, new Set(["host-a:/a:2", "host-b:/a:1"])],
    ]);
    expect(aggregateWindowUnreadTasks(counts, undefined, keys)).toBe(3);
    keys.set(2, new Set(["host-a:/a:1", "host-a:/a:2"]));
    expect(aggregateWindowUnreadTasks(counts, undefined, keys)).toBe(2);
    keys.set(2, new Set(["host-b:/a:1", "host-b:/a:2"]));
    expect(aggregateWindowUnreadTasks(counts, undefined, keys)).toBe(4);
    counts.delete(2);
    keys.delete(2);
    expect(aggregateWindowUnreadTasks(counts, undefined, keys)).toBe(2);
  });
});
