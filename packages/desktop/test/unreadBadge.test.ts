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
  });
});
