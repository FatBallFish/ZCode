import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appSettingsPatchSchema, appSettingsSchema } from "@zcode/shared";
import type { WorktreeListResult, WorktreeRegistryEntry } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { generateWorktreeId, createWorktreeRegistry } from "../src/git/worktreeRegistry.js";
import { buildWorktreeDirectoryPath, createWorktreeService } from "../src/git/worktreeService.js";
import type { GitWorktreeRepo } from "../src/git/repo/gitWorktreeRepo.js";
import type { GitCliRepo } from "../src/git/repo/gitCliRepo.js";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { WorktreeRegistry } from "../src/git/worktreeRegistry.js";

function makeEntry(overrides: Partial<WorktreeRegistryEntry> = {}): WorktreeRegistryEntry {
  const id = overrides.id ?? generateWorktreeId();
  const root = overrides.rootWorkspacePath ?? "/repos/demo";
  return {
    id,
    rootWorkspacePath: root,
    worktreePath: overrides.worktreePath ?? `/wt/demo-${id.slice(0, 4)}/${id}`,
    ref: overrides.ref ?? "origin/main",
    name: null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    lastUsedAt: overrides.lastUsedAt ?? overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

/** 纯内存 fake：不做任何 git/DB IO，用于验证编排层的资格与顺序规则。 */
function createFakeDeps(overrides?: {
  entries?: WorktreeRegistryEntry[];
  dirtyCounts?: Map<string, number | null>;
  alivePaths?: Set<string>;
  pinnedOrUnread?: Set<string>;
}) {
  const state = { entries: [...(overrides?.entries ?? [])] };
  const calls: string[] = [];
  const deletedWorkspaces: string[] = [];
  const emittedWorkspaces: string[] = [];
  const worktreeRepo: GitWorktreeRepo = {
    async listWorktrees() {
      calls.push("listWorktrees");
      return state.entries.map((entry) => ({
        path: entry.worktreePath,
        head: "abc1234",
        branch: null,
        bare: false,
        detached: true,
      }));
    },
    async addDetachedWorktree(repoRoot, worktreePath, ref) {
      calls.push(`add:${worktreePath}:${ref}`);
    },
    async removeWorktree(repoRoot, worktreePath, force) {
      calls.push(`remove:${worktreePath}:${force ? "force" : "plain"}`);
    },
    async pruneWorktrees() {
      calls.push("prune");
    },
    async fetchRemote() {
      calls.push("fetch");
      return true;
    },
    async resolveRemoteDefaultBranch() {
      return "origin/main";
    },
    async getWorktreeDirtyFileCount(path) {
      return overrides?.dirtyCounts?.get(path) ?? 0;
    },
    async getWorktreeHeadShortSha() {
      return "abc1234";
    },
  };
  const gitCliRepo = {
    async resolveRepository(workspacePath: string) {
      return {
        workspacePath,
        repoRoot: workspacePath,
        workspaceInRepoPath: "",
        autoRefreshWatchPaths: [],
        isGitAvailable: true,
        isRepository: true,
      };
    },
  } as unknown as GitCliRepo;
  const taskIndexRepo = {
    async listTaskMetas(params: { workspacePath: string }) {
      return [
        {
          taskId: "s1",
          title: "会话一",
          status: "completed",
          updatedAt: 1,
          workspacePath: params.workspacePath,
        },
      ];
    },
    async deleteWorkspaceTasks(params: { workspacePath: string }) {
      deletedWorkspaces.push(params.workspacePath);
      return 1;
    },
    async hasPinnedOrUnreadTasks(params: { workspacePath: string }) {
      return overrides?.pinnedOrUnread?.has(params.workspacePath) ?? false;
    },
  } as unknown as TaskIndexRepo;
  const registry: WorktreeRegistry = {
    async load() {
      return [...state.entries];
    },
    async save(entries) {
      state.entries = [...entries];
    },
    async mutate(mutate) {
      const result = await mutate(state.entries);
      return result;
    },
  };
  return {
    state,
    calls,
    deletedWorkspaces,
    emittedWorkspaces,
    deps: {
      worktreeRepo,
      gitCliRepo,
      registry,
      taskIndexRepo,
      resolveConfig: async () => ({
        rootDir: "/wt",
        fetchBeforeCreate: false,
        autoPruneEnabled: false,
        autoPruneLimit: 5,
      }),
      isWorkspaceRuntimeAlive: (path: string) => overrides?.alivePaths?.has(path) ?? false,
      disposeWorkspaceRuntime: (path: string) => {
        calls.push(`dispose:${path}`);
        overrides?.alivePaths?.delete(path);
        return Promise.resolve();
      },
      emitWorkspaceTasksChanged: (path: string) => {
        emittedWorkspaces.push(path);
      },
    } as Parameters<typeof createWorktreeService>[0],
  };
}

test("worktree 目录命名：<rootDir>/<repo>-<hash4>/<id8> 且同路径稳定、异路径不冲突", () => {
  const a = buildWorktreeDirectoryPath({
    rootDir: "/wt",
    rootWorkspacePath: "/repos/demo",
    id: "00112233",
  });
  const b = buildWorktreeDirectoryPath({
    rootDir: "/wt",
    rootWorkspacePath: "/repos/demo",
    id: "00112233",
  });
  const c = buildWorktreeDirectoryPath({
    rootDir: "/wt",
    rootWorkspacePath: "/other/demo",
    id: "00112233",
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^\/wt\/demo-[0-9a-f]{4}\/00112233$/);
});

test("registry：空文件返回空表；mutate 串行读改写；损坏文件隔离后从空表启动", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "worktree-reg-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  const filePath = join(base, "worktrees.json");
  const registry = createWorktreeRegistry({ filePath });
  assert.deepEqual(await registry.load(), []);

  const entry = makeEntry();
  await registry.mutate((entries) => {
    entries.push(entry);
  });
  assert.equal((await registry.load()).length, 1);

  await writeFile(filePath, "{ broken json", "utf8");
  const afterCorrupt = await registry.load();
  assert.deepEqual(afterCorrupt, []);

  const registry2 = createWorktreeRegistry({ filePath: join(base, "missing.json") });
  assert.deepEqual(await registry2.load(), []);
});

test("create：detached 目录 + 注册表条目 + ref 缺省解析远程默认分支", async () => {
  const fake = createFakeDeps();
  const service = createWorktreeService(fake.deps);
  const entry = await service.create({ rootWorkspacePath: "/repos/demo" });
  assert.match(entry.worktreePath, /\/wt\/demo-[0-9a-f]{4}\/[0-9a-f]{8}$/);
  assert.equal(entry.ref, "origin/main");
  assert.equal(fake.state.entries.length, 1);
  assert.ok(fake.calls.some((call) => call.startsWith("add:")));
});

test("remove：进程存活直接拒绝；脏树未 force 拒绝；成功后 tombstone 会话并广播", async () => {
  const entry = makeEntry();
  const alive = createFakeDeps({ entries: [entry], alivePaths: new Set([entry.worktreePath]) });
  const blocked = await createWorktreeService(alive.deps).remove({
    worktreePath: entry.worktreePath,
  });
  assert.equal(blocked.removed, false);
  assert.equal(blocked.blockReason, "process-alive");

  const dirty = createFakeDeps({
    entries: [entry],
    dirtyCounts: new Map([[entry.worktreePath, 3]]),
  });
  const dirtyResult = await createWorktreeService(dirty.deps).remove({
    worktreePath: entry.worktreePath,
  });
  assert.equal(dirtyResult.removed, false);
  assert.equal(dirtyResult.blockReason, "dirty");

  const clean = createFakeDeps({ entries: [entry] });
  const ok = await createWorktreeService(clean.deps).remove({
    worktreePath: entry.worktreePath,
  });
  assert.equal(ok.removed, true);
  assert.equal(ok.removedSessionCount, 1);
  assert.deepEqual(clean.deletedWorkspaces, [entry.worktreePath]);
  assert.deepEqual(clean.emittedWorkspaces, [entry.worktreePath]);
  assert.equal(clean.state.entries.length, 0);
});

test("自动清理（D2/D4）：按根项目计数，最旧优先，遇不合格候选即停", async () => {
  const oldest = makeEntry({ id: "a0000000", lastUsedAt: "2026-01-01T00:00:00.000Z" });
  const middle = makeEntry({ id: "b0000000", lastUsedAt: "2026-02-01T00:00:00.000Z" });
  const fake = createFakeDeps({ entries: [oldest, middle] });
  fake.deps.resolveConfig = async () => ({
    rootDir: "/wt",
    fetchBeforeCreate: false,
    autoPruneEnabled: true,
    autoPruneLimit: 2,
  });
  const service = createWorktreeService(fake.deps);
  // 创建第三个（不计入 fake.calls 的已有条目），超限 1 → 应删除最旧的 oldest。
  await service.create({ rootWorkspacePath: "/repos/demo" });
  const remainingIds = fake.state.entries.map((item) => item.id);
  assert.ok(!remainingIds.includes("a0000000"), "最旧工作树应被自动清理");
  assert.ok(remainingIds.includes("b0000000"), "较新工作树应保留");
  assert.equal(fake.state.entries.length, 2);

  // 有置顶/未读会话时不得清理任何条目。
  const pinnedFake = createFakeDeps({
    entries: [oldest, middle],
    pinnedOrUnread: new Set([oldest.worktreePath]),
  });
  pinnedFake.deps.resolveConfig = fake.deps.resolveConfig;
  await createWorktreeService(pinnedFake.deps).create({ rootWorkspacePath: "/repos/demo" });
  assert.equal(pinnedFake.state.entries.filter((item) => item.id === "a0000000").length, 1);
});

test("remove：进程存活时 force 先停空闲 runtime 再删；running 任务仍拦截", async () => {
  const entry = makeEntry();
  const fake = createFakeDeps({ entries: [entry], alivePaths: new Set([entry.worktreePath]) });
  fake.deps.taskIndexRepo = {
    ...fake.deps.taskIndexRepo,
    hasRunningTasks: async () => true,
  } as unknown as typeof fake.deps.taskIndexRepo;
  const blocked = await createWorktreeService(fake.deps).remove({
    worktreePath: entry.worktreePath,
    force: true,
  });
  assert.equal(blocked.removed, false);
  assert.equal(blocked.blockReason, "process-alive");
  assert.ok(!fake.calls.some((call) => call.startsWith("dispose:")));

  const idle = createFakeDeps({ entries: [entry], alivePaths: new Set([entry.worktreePath]) });
  idle.deps.taskIndexRepo = {
    ...idle.deps.taskIndexRepo,
    hasRunningTasks: async () => false,
  } as unknown as typeof idle.deps.taskIndexRepo;
  const removed = await createWorktreeService(idle.deps).remove({
    worktreePath: entry.worktreePath,
    force: true,
  });
  assert.equal(removed.removed, true);
  assert.ok(idle.calls.some((call) => call.startsWith("dispose:")));
  assert.ok(idle.calls.some((call) => call.startsWith(`remove:${entry.worktreePath}:force`)));
});

test("list：按根项目分组、lastUsedAt 倒序、关联会话与状态摘要", async () => {
  const older = makeEntry({ id: "a0000000", lastUsedAt: "2026-01-01T00:00:00.000Z" });
  const newer = makeEntry({ id: "b0000000", lastUsedAt: "2026-03-01T00:00:00.000Z" });
  const otherRepo = makeEntry({
    id: "c0000000",
    rootWorkspacePath: "/repos/other",
    lastUsedAt: "2026-02-01T00:00:00.000Z",
  });
  const fake = createFakeDeps({ entries: [older, newer, otherRepo] });
  const result: WorktreeListResult = await createWorktreeService(fake.deps).list();
  assert.equal(result.groups.length, 2);
  const demoGroup = result.groups.find((group) => group.repoName === "demo");
  assert.ok(demoGroup);
  assert.deepEqual(
    demoGroup.worktrees.map((item) => item.entry.id),
    ["b0000000", "a0000000"],
  );
  assert.equal(demoGroup.worktrees[0].diskStatus, "ready");
  assert.equal(demoGroup.worktrees[0].sessions.length, 1);
  assert.equal(demoGroup.worktrees[0].sessions[0].title, "会话一");
});

test("settings schema：worktreeConfig 进 object 与 patch 两个 schema，非法 limit 拒绝", () => {
  const valid = {
    rootDir: "~/.mikiko/worktrees",
    fetchBeforeCreate: true,
    autoPruneEnabled: false,
    autoPruneLimit: 5,
  };
  const parsedSettings = appSettingsSchema.parse({ worktreeConfig: valid });
  assert.deepEqual(parsedSettings.worktreeConfig, valid);
  const parsedPatch = appSettingsPatchSchema.parse({ worktreeConfig: valid });
  assert.deepEqual(parsedPatch.worktreeConfig, valid);

  assert.throws(() =>
    appSettingsPatchSchema.parse({
      worktreeConfig: { ...valid, autoPruneLimit: 0 },
    }),
  );
  assert.throws(() =>
    appSettingsPatchSchema.parse({
      worktreeConfig: { ...valid, autoPruneLimit: 999 },
    }),
  );
  assert.throws(() =>
    appSettingsPatchSchema.parse({
      worktreeConfig: { ...valid, rootDir: "  " },
    }),
  );
});
