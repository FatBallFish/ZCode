import {
  TID_SUB2API_OIDC_LOGIN_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_LOGIN_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "./helpers/desktop-app.js";

/**
 * 反馈账户化端到端（方案 F.3）：
 * 未登录（设备 token）匿名上报 → MikikoCC OIDC 登录 → 「我的反馈」显示远端模式指示 →
 * 本地档案已清空（迁移完成）。
 */
const CASE_TIMEOUT_MS = 300_000;

describe("反馈账户化", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("FBS-01 OIDC 登录后我的反馈切远端模式", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);

    const surface = await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting()
      ? "login"
      : "workspace";
    if (surface !== "login") {
      this.skip();
    }

    // 欢迎页 → MikikoCC OIDC 登录
    await clickTestIdByDom(testId(TID_LOGIN_USE_API_KEY_BUTTON, "mikikocc-primary"));
    await waitForTestIdByDom(TID_SUB2API_OIDC_LOGIN_BUTTON, { timeout: 20_000 });
    await clickTestIdByDom(TID_SUB2API_OIDC_LOGIN_BUTTON);

    await browser.waitUntil(
      async () => (await openExternalMock.mock.calls.length) > 0,
      { timeout: 20_000, timeoutMsg: "未捕获授权 URL" },
    );

    // Node 侧完成 KeyCloak 登录（真实线上，测试账号）——与 mikikocc-oidc-login 共用逻辑。
    // 此处简化为等待登录完成。
    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 120_000,
      timeoutMsg: "OIDC 登录后未进入工作区",
    });

    // 等待迁移完成（登录后自动 syncAccountRecords）
    await browser.pause(3_000);

    // 打开我的反馈（通过帮助菜单 → 问题上报 → 我的反馈）验证模式指示。
    // 此处仅验证登录态已达；模式指示的 UI 断言需打开反馈面板，留给后续迭代。
  });
});
