import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { projectStorage } from "#src/project-storage/index.js";
import {
  applyProjectSeedRecovery,
  fingerprintProjectDatabase,
  planProjectSeedRecovery,
} from "#src/project-storage/startup-entry.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mikiko-project-recovery-contract-"));
  roots.push(root);
  const files = {
    databasePath: join(root, "app.sqlite"),
    settingsPath: join(root, "setting.json"),
    sourceSettingsPath: join(root, "source.json"),
    backupDirectory: join(root, "backup"),
  };
  const index = new TaskIndexRepo({ recentProjects: [] }, undefined, files.databasePath);
  try {
    for (const [taskId, path, pin] of [
      ["pin", "/fixture/pinned", true],
      ["normal", "/fixture/normal", false],
      ["unclassified", "/fixture/removed", false],
      ["conversation", "/fixture/conversation", false],
    ] as const) {
      await index.applyCliFacts({
        meta: {
          taskId,
          traceId: taskId,
          title: taskId,
          workspacePath: path,
          createdAt: 11,
          updatedAt: 23,
          mode: "build",
          provider: "glm",
        },
        titleSource: "generated",
      });
      await index.updateTaskState({
        taskId,
        workspacePath: path,
        patch: { pinned: pin, archived: taskId === "unclassified" },
      });
    }
  } finally {
    index.close();
  }
  await writeFile(
    files.settingsPath,
    JSON.stringify({ locale: "en-US", lastWorkspaceSession: [] }),
  );
  await writeFile(
    files.sourceSettingsPath,
    JSON.stringify({
      lastWorkspaceSession: ["/fixture/empty", "/fixture/pinned", "/fixture/normal"]
        .map((workspacePath) => ({ kind: "local", workspacePath, workspacePurpose: "project" }))
        .concat([
          {
            kind: "local",
            workspacePath: "/fixture/conversation",
            workspacePurpose: "conversation",
          },
        ]),
    }),
  );
  return files;
}

function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      state: fingerprintProjectDatabase(db),
      tasks: db.prepare("SELECT * FROM tasks ORDER BY task_id").all(),
      tree: projectStorage.repository(db).readTree(),
    };
  } finally {
    db.close();
  }
}

it("recovers explicit saved empty/pinned/normal projects once while preserving every task fact", async () => {
  const files = await fixture();
  const before = inspect(files.databasePath);
  const plan = await planProjectSeedRecovery(files);
  expect(plan).toMatchObject({ projectCount: 3, matchingTasks: 2, remainingUnclassifiedTasks: 2 });
  expect(inspect(files.databasePath).state).toEqual(before.state);
  const settings = await readFile(files.settingsPath);
  const result = await applyProjectSeedRecovery(files, plan);
  expect(result).toMatchObject({
    projectCount: 3,
    assignedTasks: 2,
    remainingUnclassifiedTasks: 2,
  });
  const after = inspect(files.databasePath);
  expect(after.tree.projects.map((p) => p.roots[0]?.rootPath)).toEqual([
    "/fixture/empty",
    "/fixture/pinned",
    "/fixture/normal",
  ]);
  const facts = (rows: typeof before.tasks) =>
    rows.map(({ project_id: _organization, ...row }) => row);
  expect(facts(after.tasks)).toEqual(facts(before.tasks));
  expect(after.tree.tasks.find((task) => task.taskId === "pin")?.pinned).toBe(true);
  expect(after.tasks.find((task) => task.task_id === "unclassified")?.project_id).toBeNull();
  expect(after.tasks.find((task) => task.task_id === "conversation")?.project_id).toBeNull();
  for (const [table, hash] of Object.entries(before.state.tableHashes))
    if (!["projects", "project_roots", "tasks"].includes(table))
      expect(after.state.tableHashes[table]).toBe(hash);
  expect(await readFile(files.settingsPath)).toEqual(settings);
  expect(inspect(join(files.backupDirectory, "app-before.sqlite")).state).toEqual(before.state);
  await expect(applyProjectSeedRecovery(files, plan)).rejects.toThrow("existing-organization");
});

it.each(["database", "settings", "source"] as const)(
  "rejects concurrent %s changes against the approved fingerprint",
  async (kind) => {
    const files = await fixture();
    const plan = await planProjectSeedRecovery(files);
    if (kind === "database") {
      const db = new DatabaseSync(files.databasePath);
      try {
        db.prepare("UPDATE tasks SET pinned=0 WHERE task_id='pin'").run();
      } finally {
        db.close();
      }
    } else
      await writeFile(
        kind === "settings" ? files.settingsPath : files.sourceSettingsPath,
        kind === "settings"
          ? "{}"
          : JSON.stringify({
              lastWorkspaceSession: [{ kind: "local", workspacePath: "/different" }],
            }),
      );
    const before = inspect(files.databasePath).state;
    await expect(applyProjectSeedRecovery(files, plan)).rejects.toThrow("fingerprint-changed");
    expect(inspect(files.databasePath).state).toEqual(before);
  },
);

it("rejects even a soft-deleted organization rather than resurrecting removed projects", async () => {
  const files = await fixture();
  const db = new DatabaseSync(files.databasePath);
  try {
    const repo = projectStorage.repository(db);
    repo.deleteProject(repo.saveProject({ roots: ["/existing"] }).id);
  } finally {
    db.close();
  }
  await expect(planProjectSeedRecovery(files)).rejects.toThrow("existing-organization");
});

it.each([
  [{ lastWorkspaceSession: [] }, "invalid-source"],
  [{ lastWorkspaceSession: [{ kind: "local", workspacePath: "relative" }] }, "invalid-source"],
  [
    {
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/remote",
          target: { kind: "docker", container: "example" },
          lastOpenedAt: 1,
          lastConnectionStatus: "connected",
        },
      ],
    },
    "remote-source-rejected",
  ],
])("rejects unsupported recovery source %j", async (source, reason) => {
  const files = await fixture();
  await writeFile(files.sourceSettingsPath, JSON.stringify(source));
  await expect(planProjectSeedRecovery(files)).rejects.toThrow(String(reason));
});

it.each([
  [
    "DELETE FROM schema_migration WHERE id IN ('0005_projects','0001_projects')",
    "project-migration-missing",
  ],
  ["DELETE FROM hosts WHERE host_id='local'", "local-owner-missing"],
  ["UPDATE tasks SET project_id='external' WHERE task_id='pin'", "existing-task-membership"],
])("rejects inconsistent input state without editing it: %s", async (sql, reason) => {
  const files = await fixture();
  const db = new DatabaseSync(files.databasePath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  await expect(planProjectSeedRecovery(files)).rejects.toThrow(reason);
});

it.each([
  "UPDATE tasks SET root_path='/changed-by-trigger' WHERE task_id='pin'",
  "UPDATE tasks SET title='changed-by-trigger',pinned=0 WHERE task_id='pin'",
  "INSERT INTO unrelated VALUES('unexpected')",
])(
  "rolls back the entire repair when existing triggers violate the approved write set",
  async (action) => {
    const files = await fixture();
    const db = new DatabaseSync(files.databasePath);
    try {
      db.exec(
        `CREATE TABLE unrelated(value TEXT); CREATE TRIGGER unexpected_seed_change AFTER INSERT ON projects BEGIN ${action}; END;`,
      );
    } finally {
      db.close();
    }
    const plan = await planProjectSeedRecovery(files);
    const before = inspect(files.databasePath).state;
    await expect(applyProjectSeedRecovery(files, plan)).rejects.toThrow(
      /task-count-changed|unexpected-table-change|unexpected-task-facts-change/,
    );
    expect(inspect(files.databasePath).state).toEqual(before);
  },
);
