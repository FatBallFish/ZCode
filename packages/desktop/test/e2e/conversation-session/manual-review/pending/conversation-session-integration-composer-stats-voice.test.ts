import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  switchV4Model,
  getV4ModelConfig,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ComposerText,
  waitForV4AssistantMessageContaining,
  getV4PaneSnapshot,
} from "#e2e/helpers/v4-conversation";
import { UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL } from "#e2e/helpers/upstream-provider";
import {
  waitForUpstreamNetworkCapture,
  assertUpstreamRequestCapture,
} from "#e2e/helpers/upstream-capture";
import {
  cleanupIntegrationProfile,
  prepareIntegrationProfile,
  readMainProviderRequests,
  waitForTaskMembership,
  writeIntegrationEvidence,
} from "#e2e/helpers/integration-acceptance";

const MARKER = "E2E_INTEGRATION_COMPOSER_STATS";
describe("Mikiko integration: combined model menu, stats and voice permission denial", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await cleanupIntegrationProfile();
  });
  it("INT-E2E-02: actual model selection reaches loopback wire once, stats settle, voice denial preserves draft", async function () {
    this.timeout(180_000);
    await prepareIntegrationProfile();
    await prepareV4ConversationE2E();
    await setV4ComposerText(MARKER);
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL, "max");
    expect(await getV4ModelConfig()).toMatchObject({
      provider: UPSTREAM_PROVIDER_ID,
      model: UPSTREAM_SECONDARY_MODEL,
      thought: "max",
    });
    await $("[data-composer-combined-model]").waitForDisplayed();
    await sendV4Prompt(MARKER);
    await waitForV4AssistantMessageContaining("INTEGRATION_COMPOSER_OK");
    const capture = await waitForUpstreamNetworkCapture(MARKER);
    assertUpstreamRequestCapture(capture, {
      expectedText: MARKER,
      model: UPSTREAM_SECONDARY_MODEL,
    });
    expect(await readMainProviderRequests(MARKER)).toHaveLength(1);
    const task = await getV4PaneSnapshot();
    expect((await waitForTaskMembership(task.sessionId!))[0]!.workspace_path).toBe(
      DEFAULT_WORKSPACE,
    );
    const stats = $('[data-testid="chat-session-stats-trigger"]');
    await stats.waitForDisplayed();
    await browser.waitUntil(
      async () => /1.*(?:turn|轮).*1.*(?:step|步)/.test(await stats.getText()),
      { timeout: 15_000, timeoutMsg: "CLI completion stats did not settle to one turn / one step" },
    );
    expect(await stats.getText()).toMatch(/1.*(?:turn|轮).*1.*(?:step|步)/);
    await stats.click();
    await $('[data-testid="chat-session-stats-content"]').waitForDisplayed();
    await browser.keys("Escape");
    const preservedDraft = "MIKIKO_INTEGRATION_UNSENT_VOICE_DRAFT";
    await setV4ComposerText(preservedDraft);
    const permission = await browser.electron.mock("systemPreferences", "getMediaAccessStatus");
    try {
      await permission.mockReturnValue("denied");
      await $('[data-testid="composer-voice-input-button"]').click();
      await $('[data-testid="voice-input-overlay"][data-voice-phase="error"]').waitForDisplayed();
      await $('[data-testid="voice-input-overlay-close"]').click();
      await waitForV4ComposerText(
        preservedDraft,
        "Voice denial must preserve unsent composer content",
      );
      expect(await readMainProviderRequests(MARKER)).toHaveLength(1);
      await writeIntegrationEvidence("INT-E2E-02", {
        taskId: task.sessionId,
        selected: await getV4ModelConfig(),
        wireHost: capture.host,
        requestCount: 1,
        stats: await stats.getText(),
        voicePermission: "denied",
        preservedDraft,
      });
    } finally {
      await permission.mockRestore();
    }
  });
});
