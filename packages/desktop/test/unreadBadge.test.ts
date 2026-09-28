<<<<<<< HEAD
import { describe, expect, it, vi } from "vitest";
import {
  parseWindowUnreadCount,
  sumWindowUnreadCounts,
  supportsAppUnreadBadge,
  syncAppUnreadBadge,
} from "../src/main/unreadBadge.js";

describe("unread badge", () => {
  it("只接受非负整数的窗口未读数上报", () => {
    expect(parseWindowUnreadCount(0)).toBe(0);
    expect(parseWindowUnreadCount(3)).toBe(3);
    expect(parseWindowUnreadCount(-1)).toBeNull();
    expect(parseWindowUnreadCount(1.5)).toBeNull();
    expect(parseWindowUnreadCount("2")).toBeNull();
  });

  it("会把所有窗口的未读数聚合成应用级总数", () => {
    expect(
      sumWindowUnreadCounts(
        new Map([
          [1, 2],
          [2, 3],
          [3, 0],
        ]),
      ),
    ).toBe(5);
  });

  it("只在 macOS / Linux 启用应用级 badge", () => {
    expect(supportsAppUnreadBadge("darwin")).toBe(true);
    expect(supportsAppUnreadBadge("linux")).toBe(true);
    expect(supportsAppUnreadBadge("win32")).toBe(false);
  });

  it("支持的平台会把聚合结果写回宿主 badge", () => {
    const setBadgeCount = vi.fn();

    syncAppUnreadBadge({
      platform: "darwin",
      totalUnreadCount: 4,
      setBadgeCount,
    });

    expect(setBadgeCount).toHaveBeenCalledWith(4);
  });

  it("Windows 一期保持 no-op，不提前引入窗口级 overlay 语义", () => {
    const setBadgeCount = vi.fn();

    syncAppUnreadBadge({
      platform: "win32",
      totalUnreadCount: 4,
      setBadgeCount,
    });

    expect(setBadgeCount).not.toHaveBeenCalled();
=======
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sumWindowUnreadCounts } from "../src/main/unreadBadge.ts";

describe("sumWindowUnreadCounts：相同 workspace 集合的窗口去重", () => {
  it("单窗口直通", () => {
    assert.equal(sumWindowUnreadCounts(new Map([[1, 7]])), 7);
  });

  it("相同集合的多个窗口只计一次（取最大值，2026-09-28 badge 翻倍修复）", () => {
    const counts = new Map<number, number>([
      [1, 41],
      [2, 41],
    ]);
    const workspaces = new Map<number, ReadonlySet<string>>([
      [1, new Set(["/a", "/b"])],
      [2, new Set(["/b", "/a"])],
    ]);
    assert.equal(sumWindowUnreadCounts(counts, workspaces), 41);
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
    assert.equal(sumWindowUnreadCounts(counts, workspaces), 8);
  });

  it("未上报集合的窗口按窗口独立计", () => {
    const counts = new Map<number, number>([
      [1, 2],
      [2, 3],
    ]);
    assert.equal(sumWindowUnreadCounts(counts), 5);
    assert.equal(sumWindowUnreadCounts(counts, new Map()), 5);
  });

  it("空集合（窗口尚未上报 workspace）视为独立 scope", () => {
    const counts = new Map<number, number>([
      [1, 2],
      [2, 2],
    ]);
    const workspaces = new Map<number, ReadonlySet<string>>([[1, new Set()]]);
    assert.equal(sumWindowUnreadCounts(counts, workspaces), 4);
>>>>>>> 5903af58 (fix(desktop): Dock 未读角标重复计数与挂死修复)
  });
});
