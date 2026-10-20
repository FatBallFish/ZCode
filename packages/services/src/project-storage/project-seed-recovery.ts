import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, posix, win32 } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { appSettingsSchema } from "@zcode/shared";
import { withAtomicFileLock } from "#src/fs/atomicFileUtils.js";
import { createProject } from "#src/project-storage/migrate-projects.js";

const { DatabaseSync, backup } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export interface ProjectSeedRecoveryFiles {
  databasePath: string;
  settingsPath: string;
  sourceSettingsPath: string;
  backupDirectory: string;
}
export interface ProjectSeedRecoveryPlan {
  version: 1;
  databaseFingerprint: string;
  settingsSha256: string;
  sourceSha256: string;
  tableHashes: Record<string, string>;
  projectCount: number;
  matchingTasks: number;
  remainingUnclassifiedTasks: number;
}

/** 全表内容与 schema 的逻辑指纹；包含 WAL 中已提交事实，不把文件大小/mtime当一致性。 */
export function fingerprintProjectDatabase(db: Database) {
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  const tableHashes: Record<string, string> = {};
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) {
    const name = String(row.name);
    const values = db
      .prepare(`SELECT * FROM ${quote(name)}`)
      .all()
      .map((value) => JSON.stringify(value))
      .sort();
    tableHashes[name] = sha(JSON.stringify(values));
  }
  return { tableHashes, fingerprint: sha(JSON.stringify({ schema, tableHashes })) };
}

function fingerprintTaskFacts(db: Database) {
  return sha(
    JSON.stringify(
      db
        .prepare("SELECT * FROM tasks")
        .all()
        .map(({ project_id: _organization, ...facts }) => JSON.stringify(facts))
        .sort(),
    ),
  );
}

async function sourceRoots(files: ProjectSeedRecoveryFiles) {
  const source = await readFile(files.sourceSettingsPath);
  const raw = JSON.parse(source.toString("utf8"));
  const parsed = appSettingsSchema.parse({ lastWorkspaceSession: raw.lastWorkspaceSession });
  const entries = parsed.lastWorkspaceSession ?? [];
  if (entries.some((entry) => entry.kind !== "local"))
    throw new Error("project.recovery-remote-source-rejected");
  const roots = [
    ...new Set(
      entries
        .filter((entry) => entry.workspacePurpose !== "conversation")
        .map((entry) => entry.workspacePath),
    ),
  ];
  if (
    !roots.length ||
    roots.some(
      (root) => root !== root.trim() || (!posix.isAbsolute(root) && !win32.isAbsolute(root)),
    )
  )
    throw new Error("project.recovery-invalid-source");
  return { roots, sourceSha256: sha(source) };
}

function inspectEmptySeed(db: Database, roots: string[]) {
  for (const table of ["projects", "project_roots", "remote_project_entries"])
    if (Number(db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get()?.n) !== 0)
      throw new Error("project.recovery-existing-organization");
  if (
    !db
      .prepare("SELECT 1 FROM schema_migration WHERE id IN ('0005_projects','0001_projects')")
      .get()
  )
    throw new Error("project.recovery-project-migration-missing");
  if (!db.prepare("SELECT 1 FROM hosts WHERE host_id='local'").get())
    throw new Error("project.recovery-local-owner-missing");
  if (db.prepare("SELECT 1 FROM tasks WHERE project_id IS NOT NULL LIMIT 1").get())
    throw new Error("project.recovery-existing-task-membership");
  let matchingTasks = 0;
  for (const root of roots)
    matchingTasks += Number(
      db
        .prepare(`SELECT count(*) AS n FROM tasks
      WHERE host_id='local' AND project_id IS NULL AND coalesce(trim(workspace_identity),'')=''
      AND root_path=?`)
        .get(root)?.n,
    );
  const total = Number(
    db.prepare("SELECT count(*) AS n FROM tasks WHERE project_id IS NULL").get()?.n,
  );
  return { matchingTasks, remainingUnclassifiedTasks: total - matchingTasks };
}

/** 明确的工程恢复计划，只读；不从 tasks 或旧品牌目录推断应恢复的项目。 */
export async function planProjectSeedRecovery(
  files: ProjectSeedRecoveryFiles,
): Promise<ProjectSeedRecoveryPlan> {
  const source = await sourceRoots(files);
  const db = new DatabaseSync(files.databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const counts = inspectEmptySeed(db, source.roots);
    const state = fingerprintProjectDatabase(db);
    const settingsSha256 = sha(await readFile(files.settingsPath));
    db.exec("COMMIT");
    return {
      version: 1,
      databaseFingerprint: state.fingerprint,
      settingsSha256,
      sourceSha256: source.sourceSha256,
      tableHashes: state.tableHashes,
      projectCount: source.roots.length,
      ...counts,
    };
  } finally {
    db.close();
  }
}

function assertPlan(actual: ProjectSeedRecoveryPlan, expected: ProjectSeedRecoveryPlan) {
  if (
    actual.databaseFingerprint !== expected.databaseFingerprint ||
    actual.settingsSha256 !== expected.settingsSha256 ||
    actual.sourceSha256 !== expected.sourceSha256 ||
    actual.projectCount !== expected.projectCount ||
    actual.matchingTasks !== expected.matchingTasks
  )
    throw new Error("project.recovery-fingerprint-changed");
}

/** 调用方先关闭业务写者；同设置写锁与 SQLite 写事务内复验，变动即拒绝。 */
export async function applyProjectSeedRecovery(
  files: ProjectSeedRecoveryFiles,
  expected: ProjectSeedRecoveryPlan,
) {
  assertPlan(await planProjectSeedRecovery(files), expected);
  // 必须先有完整一致性备份；备份失败时尚未进入任何组织态写入。
  await mkdir(files.backupDirectory, { mode: 0o700, recursive: false });
  await chmod(files.backupDirectory, 0o700);
  const before = new DatabaseSync(files.databasePath, { readOnly: true });
  try {
    await backup(before, join(files.backupDirectory, "app-before.sqlite"));
  } finally {
    before.close();
  }
  await chmod(join(files.backupDirectory, "app-before.sqlite"), 0o600);
  await copyFile(files.settingsPath, join(files.backupDirectory, "setting-before.json"));
  await chmod(join(files.backupDirectory, "setting-before.json"), 0o600);
  await copyFile(files.sourceSettingsPath, join(files.backupDirectory, "source-setting.json"));
  await chmod(join(files.backupDirectory, "source-setting.json"), 0o600);
  const saved = new DatabaseSync(join(files.backupDirectory, "app-before.sqlite"), {
    readOnly: true,
  });
  try {
    if (
      fingerprintProjectDatabase(saved).fingerprint !== expected.databaseFingerprint ||
      sha(await readFile(join(files.backupDirectory, "setting-before.json"))) !==
        expected.settingsSha256 ||
      sha(await readFile(join(files.backupDirectory, "source-setting.json"))) !==
        expected.sourceSha256
    )
      throw new Error("project.recovery-backup-fingerprint-changed");
  } finally {
    saved.close();
  }
  await writeFile(join(files.backupDirectory, "plan.json"), JSON.stringify(expected, null, 2), {
    mode: 0o600,
  });

  return withAtomicFileLock(files.settingsPath, async () => {
    const source = await sourceRoots(files);
    const db = new DatabaseSync(files.databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      const counts = inspectEmptySeed(db, source.roots);
      const state = fingerprintProjectDatabase(db);
      const taskFactsBefore = fingerprintTaskFacts(db);
      assertPlan(
        {
          version: 1,
          databaseFingerprint: state.fingerprint,
          tableHashes: state.tableHashes,
          settingsSha256: sha(await readFile(files.settingsPath)),
          sourceSha256: source.sourceSha256,
          projectCount: source.roots.length,
          ...counts,
        },
        expected,
      );
      const now = Date.now();
      let assignedTasks = 0;
      for (const root of source.roots) {
        // 复用既有首次种子的项目/roots写入规则；不执行旧迁移或全表首次归属判定。
        const name = root.includes("\\") ? win32.basename(root) : basename(root);
        const id = createProject(db, "local", name, [root], false, now);
        assignedTasks += Number(
          db
            .prepare(`UPDATE tasks SET project_id=?
          WHERE host_id='local' AND project_id IS NULL AND coalesce(trim(workspace_identity),'')=''
          AND root_path=?`)
            .run(id, root).changes,
        );
      }
      if (assignedTasks !== expected.matchingTasks)
        throw new Error("project.recovery-task-count-changed");
      // 既有触发器也可能改 tasks；仅允许 project_id 变化，CLI 事实和其余组织态必须逐列保留。
      if (fingerprintTaskFacts(db) !== taskFactsBefore)
        throw new Error("project.recovery-unexpected-task-facts-change");
      const after = fingerprintProjectDatabase(db);
      const changedTables = Object.keys(state.tableHashes).filter(
        (table) => state.tableHashes[table] !== after.tableHashes[table],
      );
      if (changedTables.some((table) => !["projects", "project_roots", "tasks"].includes(table)))
        throw new Error("project.recovery-unexpected-table-change");
      db.exec("COMMIT");
      return {
        projectCount: source.roots.length,
        assignedTasks,
        remainingUnclassifiedTasks: counts.remainingUnclassifiedTasks,
        changedTables,
        tableHashesBefore: state.tableHashes,
        tableHashesAfter: after.tableHashes,
      };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  });
}
