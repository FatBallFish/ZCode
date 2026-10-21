import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { TID_SETTINGS_SECTION_NAV, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

// 本case只操作隔离profile；真实权限由用户事先授予，绝不自动切换系统隐私开关。
describe("Mikiko bundled Computer Use", () => {
  it("CU-E01/02: opt-in, real permission status, idle restart and responsive settings", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const original = await setCurrentElectronRendererContentSize(1280, 800);
    try {
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "computerUse"));
      const surface = await $('[data-testid="mikiko-computer-use-settings"]');
      await surface.waitForDisplayed({ timeout: 30000 });
      const pluginSwitch = await surface.$('[role="switch"]');
      await expect(pluginSwitch).toHaveAttribute("aria-checked", "false");
      await expect(surface.$('[data-testid="mikiko-computer-use-grant-target"]')).not.toExist();
      await pluginSwitch.click();
      await expect(pluginSwitch).toHaveAttribute("aria-checked", "true");
      const grantTarget = await surface.$('[data-testid="mikiko-computer-use-grant-target"]');
      await grantTarget.waitForDisplayed({ timeout: 30000 });
      await expect(grantTarget).toHaveText(
        await realpath(process.env.MIKIKO_COMPUTER_USE_APP_PATH!),
      );
      await browser.waitUntil(
        async () => {
          const text = await surface.getText();
          return (text.match(/已授权|Granted/g) ?? []).length === 2;
        },
        { timeout: 30000, timeoutMsg: "Both actual native permission facts must be granted" },
      );
      const restart = await surface.$('button:not([role="switch"])');
      await restart.click();
      await browser.waitUntil(async () => !(await restart.getAttribute("disabled")), {
        timeout: 20000,
      });
      await expect(grantTarget).toBeDisplayed();
      const switches = await surface.$$('[role="switch"]');
      const composerSwitch = switches[1];
      if (!composerSwitch) throw new Error("Composer entry switch missing");
      await composerSwitch.click();
      await expect(composerSwitch).toHaveAttribute("aria-checked", "true");
      if (process.env.ZCODE_E2E_ARTIFACT_DIR)
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "computer-use-wide.png"),
        );
      await setCurrentElectronRendererContentSize(900, 700);
      await browser.execute(() => {
        const actions = (
          window as typeof window & { __testActions?: { setTheme?(value: string): void } }
        ).__testActions;
        actions?.setTheme?.("light");
      });
      await expect(grantTarget).toBeDisplayed();
      if (process.env.ZCODE_E2E_ARTIFACT_DIR)
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "computer-use-narrow-light.png"),
        );
      await pluginSwitch.click();
      await expect(pluginSwitch).toHaveAttribute("aria-checked", "false");
      await expect(surface.$('[data-testid="mikiko-computer-use-grant-target"]')).not.toExist();
    } finally {
      await restoreElectronRendererContentSize(original);
      await clearAppData();
    }
  });
});
