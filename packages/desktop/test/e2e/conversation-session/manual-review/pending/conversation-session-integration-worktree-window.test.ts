import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4PaneSnapshot,
} from "#e2e/helpers/v4-conversation";
import { projectSectionSelector } from "#e2e/helpers/project-sidebar";
import {
  cleanupIntegrationProfile,
  createIntegrationRepository,
  git,
  prepareIntegrationProfile,
  readHostMetrics,
  waitForTaskMembership,
  writeIntegrationEvidence,
} from "#e2e/helpers/integration-acceptance";

const MARKER = "E2E_INTEGRATION_WORKTREE_WINDOW";
describe("Mikiko integration: new project tree, real worktree and shared session window", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await cleanupIntegrationProfile();
  });
  it("INT-E2E-01: worktree first send keeps cwd/assets and opens one shared-Host session window", async function () {
    this.timeout(180_000);
    await prepareIntegrationProfile();
    await createIntegrationRepository();
    await browser.refresh();
    await prepareV4ConversationE2E();
    const rootHead = await git(DEFAULT_WORKSPACE, ["rev-parse", "HEAD"]);
    await $('button[aria-label="Work location"]').waitForClickable();
    await $('button[aria-label="Work location"]').click();
    await $("[data-worktree-location-root]").$("button*=New local worktree").click();
    await sendV4Prompt(MARKER);
    await waitForV4AssistantMessageContaining("INTEGRATION_WORKTREE_OK");
    const task = await getV4PaneSnapshot();
    expect(task.sessionId).toBeTruthy();
    const rows = await waitForTaskMembership(task.sessionId!);
    expect(rows).toHaveLength(1);
    const worktree = String(rows[0]!.workspace_path);
    expect(worktree).not.toBe(DEFAULT_WORKSPACE);
    expect(await git(worktree, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(await git(worktree, ["branch", "--show-current"])).toBe("");
    expect(await git(DEFAULT_WORKSPACE, ["rev-parse", "HEAD"])).toBe(rootHead);
    expect(
      await readFile(join(worktree, ".agents", "skills", "integration-probe", "SKILL.md"), "utf8"),
    ).toContain("MIKIKO_INTEGRATION_ASSET_SENTINEL");
    const rootProject = $(projectSectionSelector(DEFAULT_WORKSPACE));
    await rootProject
      .$(`[data-testid="${testId(TID_TASK_ITEM, task.sessionId!)}"]`)
      .waitForDisplayed();
    const hostsBefore = await readHostMetrics();
    expect(hostsBefore.length).toBeGreaterThan(0);
    const original = await browser.getWindowHandle();
    const handlesBefore = await browser.getWindowHandles();
    await rootProject
      .$(`[data-testid="${testId(TID_TASK_ITEM, task.sessionId!)}"]`)
      .click({ button: "right" });
    await $('//*[@role="menuitem" and contains(., "Open session in new window")]').click();
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === handlesBefore.length + 1,
      { timeout: 30_000 },
    );
    const newHandle = (await browser.getWindowHandles()).find(
      (handle) => !handlesBefore.includes(handle),
    )!;
    await browser.switchToWindow(newHandle);
    await $(
      '[data-session-id="' + task.sessionId + '"] [data-testid="chat-session-stats-trigger"]',
    ).waitForDisplayed();
    expect(await readHostMetrics()).toEqual(hostsBefore);
    expect((await getV4PaneSnapshot()).timelineText).toContain("INTEGRATION_WORKTREE_OK");
    await browser.closeWindow();
    await browser.switchToWindow(original);
    expect(await readHostMetrics()).toEqual(hostsBefore);
    expect(await waitForTaskMembership(task.sessionId!)).toEqual(rows);
    await writeIntegrationEvidence("INT-E2E-01", {
      taskId: task.sessionId,
      rows,
      rootHead,
      worktree,
      hostsBefore,
      hostsAfter: await readHostMetrics(),
    });
  });
});
