import { basename, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

export const PROJECT_SEED_UPGRADE_SPEC = "conversation-session-project-seed-upgrade.test.ts";
export async function seedProjectSeedUpgradeFixture(input: { specs: string[]; homeDir: string }) {
  if (!input.specs.some((spec) => spec.endsWith(PROJECT_SEED_UPGRADE_SPEC))) return;
  if (!basename(input.homeDir).startsWith(".e2e-home-integration-"))
    throw new Error("Project seed UI requires an isolated integration HOME");
  const root = join(input.homeDir, ".mikiko", "v2");
  const paths = ["empty-saved-project", "pinned-saved-project", "normal-saved-project"].map(
    (name) => join(input.homeDir, name),
  );
  const [, pinnedPath, normalPath] = paths;
  if (!pinnedPath || !normalPath) throw new Error("Project seed fixture paths are incomplete");
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
  const settingsPath = join(root, "setting.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(
    settingsPath,
    JSON.stringify({
      ...settings,
      locale: "en-US",
      localePreference: "en-US",
      desktopPetEnabled: false,
      lastWorkspaceSession: paths.map((workspacePath) => ({
        kind: "local",
        workspacePath,
        workspacePurpose: "project",
      })),
      lastActiveWorkspace: {
        kind: "local",
        workspacePath: normalPath,
        workspacePurpose: "project",
      },
      recentProjects: paths,
    }),
  );
  const db = new DatabaseSync(join(root, "tasks-index.sqlite"));
  try {
    db.exec(`CREATE TABLE tasks (
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
      task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
      mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
      last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(workspace_key,task_id));`);
    const insert =
      db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,pinned)
      VALUES(?,?,?,?,'glm',?,?,?)`);
    insert.run(
      pinnedPath,
      pinnedPath,
      "mikiko-seed-pinned",
      "MIKIKO_SAVED_PINNED_SESSION",
      10,
      20,
      1,
    );
    insert.run(
      normalPath,
      normalPath,
      "mikiko-seed-normal",
      "MIKIKO_SAVED_NORMAL_SESSION",
      11,
      21,
      0,
    );
  } finally {
    db.close();
  }
}
