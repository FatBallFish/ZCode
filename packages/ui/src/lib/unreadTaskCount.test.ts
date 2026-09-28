import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countAllUnreadTasks } from "./unreadTaskCount.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

function task(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    title: `t-${taskId}`,
    status: "completed",
    workspacePath: "/remote",
    workspaceIdentity: "remote-identity",
    createdAt: 1,
    updatedAt: 1,
    unreadAt: 100,
    ...overrides,
  } as ZCodeTaskMeta;
}

describe("countAllUnreadTasks：远端 path/identity 双桶去重", () => {
  it("主分支按 task.workspaceIdentity 归一（双桶同任务只计一次）", () => {
    const shared = { task: task("t1") };
    const total = countAllUnreadTasks({
      "/remote": {
        taskListCache: [shared.task],
        optimisticTaskListByTaskId: {},
      },
      "remote-identity": {
        taskListCache: [{ ...shared.task }],
        optimisticTaskListByTaskId: {},
      },
    });
    assert.equal(total, 1);
  });

  it("fallback 分支同样按 task.workspaceIdentity 归一（2026-09-28 badge 82 修复）", () => {
    // 双桶 taskListCache 为空（远端断连）→ 走 taskUnreadByTaskId fallback；
    // optimistic meta 携带 identity 时不得按桶 key 各计一次。
    const total = countAllUnreadTasks({
      "/remote": {
        taskListCache: null,
        optimisticTaskListByTaskId: { t1: task("t1") },
        taskUnreadByTaskId: { t1: true },
      },
      "remote-identity": {
        taskListCache: null,
        optimisticTaskListByTaskId: { t1: task("t1") },
        taskUnreadByTaskId: { t1: true },
      },
    });
    assert.equal(total, 1);
  });

  it("无 identity 的本地任务按桶 key 归一（不同任务分别计）", () => {
    const total = countAllUnreadTasks({
      "/local": {
        taskListCache: null,
        optimisticTaskListByTaskId: {
          a: task("a", { workspaceIdentity: undefined }),
          b: task("b", { workspaceIdentity: undefined }),
        },
        taskUnreadByTaskId: { a: true, b: true },
      },
    });
    assert.equal(total, 2);
  });

  it("无未读返回 0", () => {
    assert.equal(
      countAllUnreadTasks({
        "/x": {
          taskListCache: [task("t1", { unreadAt: undefined })],
          optimisticTaskListByTaskId: {},
        },
      }),
      0,
    );
  });
});
