import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  requireIntegrationReplay,
  writeIntegrationEvidence,
  readProviderCaptureRecords,
  cleanupIntegrationProfile,
} from "#e2e/helpers/integration-acceptance";

describe("R1 saved projects survive the first real Host migration", () => {
  after(async () => {
    await cleanupIntegrationProfile();
  });
  it("keeps the empty project and pinned/ordinary sessions through startup and refresh", async function () {
    this.timeout(120_000);
    const paths = requireIntegrationReplay();
    await skipOccupationOnboardingIfPresent();
    await $("#loading").waitForExist({ reverse: true, timeout: 15_000 });
    await $('[data-testid="root-startup-loading"]').waitForExist({
      reverse: true,
      timeout: 45_000,
    });
    await $('[data-testid="sidebar"]').waitForDisplayed({ timeout: 45_000 });
    for (const name of ["empty-saved-project", "pinned-saved-project", "normal-saved-project"])
      await $(`[data-project-name="${name}"]`).waitForDisplayed();
    expect(await $$("[data-project-id]").length).toBe(3);
    await $('[data-testid="task-item-mikiko-seed-pinned"]').waitForDisplayed();
    await $(
      '[data-project-name="normal-saved-project"] [data-testid="task-item-mikiko-seed-normal"]',
    ).waitForDisplayed();
    const before = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-project-name]")).map((node) =>
        node.getAttribute("data-project-name"),
      ),
    );
    await browser.refresh();
    await $("#loading").waitForExist({ reverse: true, timeout: 15_000 });
    await $('[data-testid="root-startup-loading"]').waitForExist({
      reverse: true,
      timeout: 45_000,
    });
    for (const name of before) await $(`[data-project-name="${name}"]`).waitForDisplayed();
    const db = new DatabaseSync(join(paths.storageRoot, "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    let stats;
    try {
      stats = {
        projects: db.prepare("SELECT count(*) AS n FROM projects WHERE deleted=0").get(),
        roots: db.prepare("SELECT count(*) AS n FROM project_roots").get(),
        tasks: db
          .prepare(
            "SELECT task_id,workspace_path,root_path,pinned,archived,project_id FROM tasks WHERE task_id LIKE 'mikiko-seed-%' ORDER BY task_id",
          )
          .all(),
      };
      expect(stats.projects?.n).toBe(3);
      expect(stats.roots?.n).toBe(3);
      expect(stats.tasks).toHaveLength(2);
      expect(
        stats.tasks.every((task) => task.workspace_path === task.root_path && task.project_id),
      ).toBe(true);
      expect(stats.tasks.find((task) => task.task_id === "mikiko-seed-pinned")?.pinned).toBe(1);
    } finally {
      db.close();
    }
    expect(await readProviderCaptureRecords()).toEqual([]);
    await writeIntegrationEvidence("R1-project-seed-upgrade", { projectNames: before, stats });
  });
});
