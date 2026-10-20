// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { projectHasUnread } from "@/project-sidebar/view.js";

const probes = vi.hoisted(() => ({
  enabled: true,
  sync: vi.fn(),
  tree: { projects: [], tasks: [] } as ProjectTree,
  availability: new Map(),
  deviceNames: new Map(),
  groups: {},
  preferences: { sort: <T>(items: T[]) => items, order: [] },
}));
vi.mock("@/project-sidebar/useProjectTree.js", () => ({
  useProjectTree: () => ({
    tree: probes.tree,
    factTree: probes.tree,
    availability: probes.availability,
    directory: { hosts: [], entries: [] },
    loading: false,
  }),
}));
vi.mock("@/hooks/useSourceServerDisplayNames.js", () => ({
  useSourceServerDisplayNames: () => probes.deviceNames,
}));
vi.mock("@/project-sidebar/useTaskGroups.js", () => ({ useTaskGroups: () => probes.groups }));
vi.mock("@/project-sidebar/useProjectSidebarPreferences.js", () => ({
  useProjectSidebarPreferences: () => probes.preferences,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ syncWindowUnreadCount: probes.sync }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (select: (state: { notificationEnabled: boolean }) => unknown) =>
    select({ notificationEnabled: probes.enabled }),
}));
afterEach(() => {
  cleanup();
  probes.sync.mockClear();
  probes.enabled = true;
});
it("notification changes clear the reported identity set without erasing Host unread facts", () => {
  const project = {
    id: "project",
    hostId: "local",
    name: "Project",
    roots: [],
    position: 0,
    pinned: false,
    deleted: false,
    nameOverridden: false,
  };
  const task = {
    taskId: "task",
    traceId: "trace",
    title: "Task",
    workspacePath: "/repo",
    hostId: "local",
    projectId: project.id,
    mode: "default",
    pinned: false,
    archived: false,
    unreadAt: 100,
    createdAt: 1,
    updatedAt: 1,
  };
  probes.tree = { projects: [project], tasks: [task, task] } as ProjectTree;
  const owner = createElement(ProjectDirectoryProvider, {}, createElement("span", {}, "owner"));
  const { rerender } = render(owner);
  const keys = [JSON.stringify(["local", "/repo", "task"])];
  expect(probes.sync).toHaveBeenLastCalledWith(1, keys);
  probes.enabled = false;
  rerender(createElement(ProjectDirectoryProvider, {}, createElement("span", {}, "disabled")));
  expect(probes.sync).toHaveBeenLastCalledWith(0, []);
  expect(task.unreadAt).toBe(100);
  expect(projectHasUnread(probes.tree, project)).toBe(true);
  probes.enabled = true;
  rerender(createElement(ProjectDirectoryProvider, {}, createElement("span", {}, "restored")));
  expect(probes.sync).toHaveBeenLastCalledWith(1, keys);
});
