import { tmpdir } from "node:os";
import { join } from "node:path";
import { TID_TASK_SETTINGS_BUTTON, TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  readSettings,
  seedSettings,
  waitForWorkspaceApp,
} from "./helpers/desktop-app.js";

/**
 * 问题上报入口重开冒烟（specs/mikiko-cloud/feedback-tickets.md §1）：
 * FEEDBACK_ENTRY_ENABLED 恢复 true 后，会话帮助菜单的「问题上报」必须重新出现，
 * 点击打开反馈弹窗并渲染简化表单（描述 + 诊断日志开关）。不提交——出网链路由
 * 单测与 mikiko-cloud 端到端覆盖，这里只验证 UI 入口与表单装配。
 */

// 与 help-menu-about 相同的进入方式：隔离 HOME 首启可能弹引导，用 Escape 退出。
async function enterWorkspace() {
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
      return $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting();
    },
    { timeout: 30_000, timeoutMsg: "首次使用引导关闭后未进入工作区" },
  );
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
}

async function openHelpMenu() {
  await browser.waitUntil(
    async () => {
      for (const trigger of await $$(`[data-testid="${TID_WORKSPACE_HELP_MENU_TRIGGER}"]`)) {
        if (await trigger.isDisplayed()) return true;
      }
      return false;
    },
    { timeout: 10_000, timeoutMsg: "帮助按钮尚未挂载到可见页面" },
  );
  const triggers = await $$(`[data-testid="${TID_WORKSPACE_HELP_MENU_TRIGGER}"]`);
  for (const trigger of triggers) {
    if (await trigger.isDisplayed()) {
      await trigger.waitForClickable();
      await trigger.click();
      break;
    }
  }
  await $('[role="menu"]').waitForDisplayed();
  await $('[role="menuitem"][aria-busy="true"]').waitForExist({ reverse: true });
}

describe("问题上报入口重开", () => {
  let originalSettings: Awaited<ReturnType<typeof readSettings>>;

  before(async () => {
    await enterWorkspace();
    originalSettings = await readSettings();
    await seedSettings({ locale: "en-US", localePreference: "en-US" });
    await browser.refresh();
    await enterWorkspace();
  });

  after(async () => {
    await seedSettings(originalSettings);
  });

  it("FE-01 帮助菜单包含问题上报，点击打开反馈弹窗并渲染表单", async function () {
    this.timeout(60_000);
    await openHelpMenu();
    const reportItem = await $('[role="menuitem"]*=Report an issue');
    await expect(reportItem).toBeDisplayed();
    await reportItem.click();
    await $('[role="menu"]').waitForDisplayed({ reverse: true });

    // 反馈中心弹窗打开：标题 + 描述输入框 + 诊断日志开关。
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 10_000 });
    const dialogText = await dialog.getText();
    expect(dialogText).toContain("Submit feedback");
    const description = await dialog.$("textarea");
    await expect(description).toBeDisplayed();
    const logsToggle = await dialog.$('[data-testid="feedback-logs-opt-in"]');
    await expect(logsToggle).toBeDisplayed();

    await browser.saveScreenshot(join(tmpdir(), "zcode-feedback-reopened-en.png"));

    // 关闭后弹窗消失，可重复打开（entry flag 不是一次性状态）。
    await browser.keys("Escape");
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    await openHelpMenu();
    await (await $('[role="menuitem"]*=Report an issue')).click();
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
    await browser.keys("Escape");
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
  });

  it("FE-02 中文语言下菜单文案为「问题上报」", async function () {
    this.timeout(60_000);
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await browser.refresh();
    await enterWorkspace();
    await openHelpMenu();
    const reportItem = await $('[role="menuitem"]*=问题上报');
    await expect(reportItem).toBeDisplayed();
    await browser.keys("Escape");
    await $('[role="menu"]').waitForDisplayed({ reverse: true });
  });
});
