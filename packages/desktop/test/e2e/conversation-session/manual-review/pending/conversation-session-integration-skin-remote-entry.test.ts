import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  cleanupIntegrationProfile,
  prepareIntegrationProfile,
  readSavedSkin,
  readProviderCaptureRecords,
  writeIntegrationEvidence,
} from "#e2e/helpers/integration-acceptance";

const NAME = "E2E_INTEGRATION_CUSTOM_SKIN";
describe("Mikiko integration: persisted custom skin and self-hosted remote entry", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await cleanupIntegrationProfile();
  });
  it("INT-E2E-03: a real custom theme survives reload and the isolated remote-control dialog remains reachable", async function () {
    this.timeout(120_000);
    await prepareIntegrationProfile();
    await prepareV4ConversationE2E();
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).click();
    await $(`[data-testid="${testId(TID_SETTINGS_SECTION_NAV, "appearance")}"]`).click();
    await writeIntegrationEvidence("INT-E2E-03-appearance", {
      text: await browser.execute(() => document.body.innerText),
    });
    await $("button=Change skin").click();
    await $('[data-testid="theme-skin-manage"]').waitForDisplayed();
    await $("button=New theme").click();
    await $('[data-testid="theme-skin-edit"] input[aria-label="Name"]').setValue(NAME);
    await $("button=Save and use").click();
    await $('[data-testid="theme-skin-manage"]').waitForDisplayed();
    const saved = await readSavedSkin(NAME);
    expect(saved.record.format).toBe("mikiko-theme-skin-record");
    const snapshotBefore = await browser.execute(() =>
      JSON.parse(localStorage.getItem("mikiko-theme-skin") ?? "null"),
    );
    expect(snapshotBefore.name).toBe(NAME);
    expect(snapshotBefore.id).toBe(saved.record.id);
    await browser.refresh();
    await prepareV4ConversationE2E();
    const snapshotAfter = await browser.execute(() =>
      JSON.parse(localStorage.getItem("mikiko-theme-skin") ?? "null"),
    );
    expect(snapshotAfter).toEqual(snapshotBefore);
    const back = $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`);
    if (await back.isDisplayed()) await back.click();
    await $('[data-testid="remote-control-trigger"]').waitForClickable();
    await $('[data-testid="remote-control-trigger"]').click();
    const dialog = $('[role="dialog"]');
    await dialog.waitForDisplayed();
    expect(await dialog.getText()).toContain("Mobile remote control");
    expect(await dialog.getText()).not.toContain("Relay V2");
    const actualState = await browser.execute(async () => {
      const api = (window as unknown as { zcode: { remoteControlGetState(): Promise<unknown> } })
        .zcode;
      return api.remoteControlGetState();
    });
    expect(actualState).toMatchObject({
      enabled: true,
      state: { phase: "disabled", disabledReason: "config" },
    });
    const schedulers = await browser.electron.execute((electron) =>
      electron.app
        .getAppMetrics()
        .filter((metric) => /cron-scheduler$/i.test(metric.name ?? ""))
        .map((metric) => ({ pid: metric.pid, name: metric.name })),
    );
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.name).toBe("mikiko-cron-scheduler");
    expect(await readProviderCaptureRecords()).toEqual([]);
    await writeIntegrationEvidence("INT-E2E-03", {
      savedSkinFile: saved.path,
      persistedSkinId: saved.record.id,
      snapshotBefore,
      snapshotAfter,
      remoteState: actualState,
      schedulers,
    });
    await browser.keys("Escape");
  });
});
