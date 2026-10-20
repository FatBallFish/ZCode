import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";
import {
  countProjectTreeUnreadTasks,
  projectTreeUnreadTaskKeys,
  projectWorktreeDisplayTree,
  selectProjectRows,
} from "@/project-sidebar/view.js";

const task = (id: string, overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  projectId: "p1",
  hostId: "local",
  pinned: false,
  archived: false,
  workspacePath: "/repo",
  title: id,
  mode: "build",
  traceId: id,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const project = (id: string, hostId: string, deleted = false): VirtualProject => ({
  id,
  hostId,
  name: id,
  nameOverridden: false,
  roots: [],
  position: 0,
  pinned: false,
  deleted,
});

const tree = (
  tasks: ProjectTask[],
  projects: VirtualProject[] = [project("p1", "local")],
): ProjectTree => ({ projects, tasks });

describe("countProjectTreeUnreadTasks", () => {
  it("只统计非归档且有 unreadAt 的任务", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree([
          task("a", { unreadAt: 100 }),
          task("b", { unreadAt: undefined }),
          task("c", { unreadAt: 300, archived: true }),
        ]),
      ),
    ).toBe(1);
  });

  it("按 host+workspace+task 去重：不同 host 的同名任务分别计数", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [
            task("a", { unreadAt: 100 }),
            task("b", { unreadAt: 200 }),
            // 本地与远端主机的同路径同名任务在树里是不同实例，分别计数
            task("a", { unreadAt: 300, hostId: "remote:server" }),
          ],
          [project("p1", "local"), project("p1", "remote:server")],
        ),
      ),
    ).toBe(3);
  });

  it("空树计 0", () => {
    expect(countProjectTreeUnreadTasks(tree([]))).toBe(0);
  });

  it("孤儿任务（项目不存在）不计入：没有蓝点落点的未读不产生幽灵提醒", () => {
    expect(
      countProjectTreeUnreadTasks(tree([task("orphan", { unreadAt: 100, projectId: "ghost" })])),
    ).toBe(0);
  });

  it("软删项目的未读不计入（侧边栏不渲染已删项目）", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [task("a", { unreadAt: 100 }), task("ghost", { unreadAt: 200, projectId: "p-deleted" })],
          [project("p1", "local"), project("p-deleted", "local", true)],
        ),
      ),
    ).toBe(1);
  });

  it("置顶任务跨项目可见：软删项目的置顶未读仍计入", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [task("pinned", { unreadAt: 100, pinned: true, projectId: "p-deleted" })],
          [project("p1", "local"), project("p-deleted", "local", true)],
        ),
      ),
    ).toBe(1);
  });

  it("本地无项目任务（projectId null + host local）计入", () => {
    expect(
      countProjectTreeUnreadTasks(tree([task("local-task", { unreadAt: 100, projectId: null })])),
    ).toBe(1);
  });
});

describe("Mikiko project presentation integration", () => {
  it("reports the same stable unread keys in each window and isolates remote identities", () => {
    const rows = [
      task("a", { unreadAt: 1 }),
      task("a", { unreadAt: 1 }),
      task("a", { unreadAt: 1, workspaceIdentity: " remote:host:/repo " }),
    ];
    const keys = projectTreeUnreadTaskKeys(tree(rows));
    expect(keys).toHaveLength(2);
    expect(keys).toContain(JSON.stringify(["local", "/repo", "a"]));
    expect(keys).toContain(JSON.stringify(["local", "remote:host:/repo", "a"]));
    expect(countProjectTreeUnreadTasks(tree(rows))).toBe(keys.length);
    expect(new Set([...keys, ...projectTreeUnreadTaskKeys(tree(rows))]).size).toBe(2);
  });

  it("aggregates registered local worktrees under their root project without changing task execution identity", () => {
    const source = tree(
      [
        task("wt", { projectId: null, workspacePath: "/worktrees/branch" }),
        task("remote", {
          projectId: null,
          workspacePath: "/worktrees/branch",
          workspaceIdentity: "remote:host:/worktrees/branch",
          hostId: "remote:host",
        }),
      ],
      [{ ...project("p1", "local"), roots: [{ rootPath: "/repo", position: 0 }] }],
    );
    const projected = projectWorktreeDisplayTree(source, [
      { rootWorkspacePath: "/repo", worktreePath: "/worktrees/branch" },
    ]);
    expect(projected.tasks[0]).toEqual({ ...source.tasks[0], projectId: "p1" });
    expect(source.tasks[0].projectId).toBeNull();
    expect(projected.tasks[0].workspacePath).toBe("/worktrees/branch");
    expect(projected.tasks[1]).toBe(source.tasks[1]);
  });

  it("respects an explicit project move and does not resurrect deleted root projects", () => {
    const source = tree(
      [task("moved", { projectId: "other", workspacePath: "/branch" })],
      [{ ...project("p1", "local", true), roots: [{ rootPath: "/repo", position: 0 }] }],
    );
    expect(
      projectWorktreeDisplayTree(source, [{ rootWorkspacePath: "/repo", worktreePath: "/branch" }]),
    ).toBe(source);
  });
});

it("pinned projects retain pinned sessions in their nested task list", () => {
  const rows = tree(
    [task("pinned", { pinned: true }), task("ordinary")],
    [{ ...project("p1", "local"), pinned: true }],
  );
  expect(
    selectProjectRows(rows, { kind: "project", projectId: "p1", hostId: "local" })
      .map((row) => row.taskId)
      .sort(),
  ).toEqual(["ordinary", "pinned"]);
  expect(
    selectProjectRows(
      { ...rows, projects: [project("p1", "local")] },
      { kind: "project", projectId: "p1", hostId: "local" },
    ).map((row) => row.taskId),
  ).toEqual(["ordinary"]);
});
