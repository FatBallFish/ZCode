import {
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared";
import { clearAppData, waitForTestIdByDom } from "./helpers/desktop-app.js";

/**
 * 首启三步引导勾选「导入会话记录」后迁移向导必须弹出（Part H，2026-10-20 修复）：
 * 修复前首启路径的 firstRun 空检测会与 reopen("manual") 竞态，把刚打开的迁移弹窗
 * 立即关闭（客户反馈：从设置-引导重走才正常）。断言弹窗出现且持续可见（竞态窗口
 * 内不被关闭）。
 */
const CASE_TIMEOUT_MS = 240_000;

describe("首启引导迁移弹窗（意图抢占回归）", () => {
  after(async () => {
    await clearAppData();
  });

  it("OBM-01 三步引导勾选导入 → 迁移向导弹出并保持打开", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await waitForTestIdByDom("onboarding-page", {
      timeout: 60_000,
      timeoutMsg: "全新环境未出现三步引导",
    });

    // 第 1 步职业（默认 developer）→ Next。
    const nextButton = await $('button=Next');
    await nextButton.waitForClickable({ timeout: 20_000 });
    await nextButton.click();
    // 第 2 步模式 → Next。
    const nextStep2 = await $('button=Next');
    await nextStep2.waitForClickable({ timeout: 20_000 });
    await nextStep2.click();

    // 第 3 步偏好：勾选 Migrate conversations → Get started。
    const migrationLabel = await $("label*=Migrate conversations");
    await migrationLabel.waitForDisplayed({ timeout: 20_000 });
    await migrationLabel.click();
    const startButton = await $('button=Get started');
    await startButton.waitForClickable({ timeout: 20_000 });
    await startButton.click();

    // 迁移向导（OnboardingDialog）必须弹出：以欢迎标题出现（en locale）。
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 20_000 });
    const dialogText = await dialog.getText();
    expect(dialogText).toContain("Mikiko");

    // 竞态回归断言：firstRun 空检测的迟到关闭发生在秒级——弹窗须持续可见。
    await browser.pause(3_000);
    expect(await dialog.isDisplayed()).toBe(true);

    // 关闭向导（未运行迁移，直接 close 走欢迎页 → 关闭），验证可正常收尾。
    await browser.keys("Escape");
    await browser.waitUntil(
      async () => !(await dialog.isDisplayed()),
      { timeout: 20_000, timeoutMsg: "迁移向导未随 Esc 关闭" },
    );
    // 引导流程收尾后应能进入工作区（或回到登录页），不再被引导卡住。
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="onboarding-page"]').isExisting()) === false ||
        (await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting()) === true,
      { timeout: 30_000, timeoutMsg: "引导结束后界面未收敛" },
    );
  });
});
