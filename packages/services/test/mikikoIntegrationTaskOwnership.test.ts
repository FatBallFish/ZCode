import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { getDataBaseDir, setDataBaseDir } from "../src/paths.js";

it("worktree cleanup uses the new grouping owner and retains a CLI deletion handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikiko-worktree-handoff-"));
  const previous = getDataBaseDir();
  setDataBaseDir(directory);
  const repo = new TaskIndexRepo();
  try {
    const meta = {
      taskId: "worktree-task",
      workspacePath: join(directory, "tree"),
      title: "history",
      provider: "glm" as const,
      mode: "build",
      createdAt: 1,
      updatedAt: 2,
    };
    await repo.applyCliFacts({ meta });
    await expect(repo.deleteWorkspaceTasks({ workspacePath: meta.workspacePath })).resolves.toBe(1);
    const db = await repo.getOrganizationDatabase();
    expect(
      db
        .prepare("SELECT deleted, handoff_pending & 1 AS pending FROM tasks WHERE task_id=?")
        .get(meta.taskId),
    ).toMatchObject({ deleted: 1, pending: 1 });
    expect(
      db
        .prepare("SELECT count(*) AS count FROM task_group_members WHERE task_id=?")
        .get(meta.taskId),
    ).toMatchObject({ count: 0 });
  } finally {
    repo.close();
    setDataBaseDir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});
