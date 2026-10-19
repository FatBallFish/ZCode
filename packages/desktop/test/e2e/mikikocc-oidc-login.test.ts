import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_LOGIN_BUTTON,
  TID_SUB2API_OIDC_LOGIN_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "./helpers/desktop-app.js";

/**
 * MikikoCC Mikiko ID（KeyCloak OIDC）登录端到端（方案 Part A + I）：
 * 真实 KeyCloak + 真实 mikiko.cc（allowlist 已上线）+ 应用真实 loopback 监听。
 * 浏览器授权由 Node 侧按 KeyCloak 登录表单流程驱动（凭据经环境变量注入，不入库）：
 *   ZCODE_E2E_MIKIKO_ID_USERNAME / ZCODE_E2E_MIKIKO_ID_PASSWORD
 * 环境缺失时跳过（CI 需注入 secret）。
 */
const CASE_TIMEOUT_MS = 300_000;
const E2E_USERNAME = process.env.ZCODE_E2E_MIKIKO_ID_USERNAME?.trim() ?? "";
const E2E_PASSWORD = process.env.ZCODE_E2E_MIKIKO_ID_PASSWORD ?? "";
const ISSUER = "https://oauth.mikiko.ai/realms/mikiko";

async function waitForInitialLoginSurface(): Promise<"login" | "workspace"> {
  const hasOAuthButton = await $(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting();
  return hasOAuthButton ? "login" : "workspace";
}

/** Node 侧完成 KeyCloak 登录表单流程并把授权码送回应用的 loopback 监听。 */
async function driveKeyCloakLogin(authorizeUrl: string): Promise<void> {
  const cookieJar = new Map<string, string>();
  const applyCookies = (response: Response): void => {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  };
  const cookieHeader = (): string =>
    [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

  const loginPage = await fetch(authorizeUrl, { redirect: "manual" });
  applyCookies(loginPage);
  const html = await loginPage.text();
  const formAction =
    html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ??
    "";
  if (!formAction) {
    throw new Error(`KeyCloak 登录页解析失败: HTTP ${loginPage.status}`);
  }
  const hidden = [...html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)]
    .map((match) => `${match[1] ?? ""}=${encodeURIComponent(match[2] ?? "")}`)
    .join("&");
  const body = new URLSearchParams({
    username: E2E_USERNAME,
    password: E2E_PASSWORD,
    credentialId: "",
  });
  const submitted = await fetch(formAction, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: `${body.toString()}&${hidden}`,
  });
  applyCookies(submitted);
  const location = submitted.headers.get("location") ?? "";
  if (!location.startsWith("http://127.0.0.1:")) {
    throw new Error(`KeyCloak 登录未跳回 loopback：${location.slice(0, 80) || `HTTP ${submitted.status}`}`);
  }
  const callback = await fetch(location);
  if (callback.status !== 200) {
    throw new Error(`loopback 回调失败: HTTP ${callback.status}`);
  }
}

describe("MikikoCC Mikiko ID（OIDC）登录", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MKO-01 欢迎页 OIDC 登录全链路：授权 → 平台账号态 → 模型列表", async function () {
    if (!E2E_USERNAME || !E2E_PASSWORD) {
      this.skip();
    }
    this.timeout(CASE_TIMEOUT_MS);

    const openExternalMock = await browser.electron.mock("shell", "openExternal");
    await openExternalMock.mockResolvedValue(undefined);

    const surface = await waitForInitialLoginSurface();
    if (surface !== "login") {
      throw new Error(`预期全新环境出现登录页，实际进入 ${surface}`);
    }

    // 欢迎页首登初始选项 → MikikoCC（loginMode=mikikocc，OIDC 面板）。
    await clickTestIdByDom(testId(TID_LOGIN_USE_API_KEY_BUTTON, "mikikocc-primary"));
    await waitForTestIdByDom(TID_SUB2API_OIDC_LOGIN_BUTTON, {
      timeout: 20_000,
      timeoutMsg: "MikikoCC 登录面板未出现 OIDC 按钮",
    });
    await clickTestIdByDom(TID_SUB2API_OIDC_LOGIN_BUTTON);

    // openExternal 收到真实 authorizeUrl：校验关键参数后由 Node 完成浏览器侧登录。
    let authorizeUrl = "";
    await browser.waitUntil(
      async () => {
        await openExternalMock.update();
        authorizeUrl = String(openExternalMock.mock.calls[0]?.[0] ?? "");
        return authorizeUrl.startsWith(`${ISSUER}/protocol/openid-connect/auth`);
      },
      { timeout: 20_000, timeoutMsg: "未捕获 Mikiko ID 授权 URL" },
    );
    const authorizeParams = new URL(authorizeUrl).searchParams;
    expect(authorizeParams.get("client_id")).toBe("mikiko_code");
    expect(authorizeParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeParams.get("scope")).toContain("offline_access");
    expect(authorizeParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    await driveKeyCloakLogin(authorizeUrl);

    // 登录完成 → 欢迎页关闭进入已登录工作区（I：不再需要进设置页触发同步）。
    await waitForTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 120_000,
      timeoutMsg: "OIDC 登录完成后未进入工作区",
    });

    // 加密存储边界：sub2api.json 含 oidc.sub，不含 KeyCloak refresh token 明文。
    const configJson = await browser.electron.execute(async (electron) => {
      const requireModule = (electron as unknown as { require: NodeRequire }).require;
      const { readFile: read } = requireModule("node:fs/promises") as {
        readFile: (path: string, encoding: string) => Promise<string>;
      };
      const { join: joinPath } = requireModule("node:path") as {
        join: (...parts: string[]) => string;
      };
      try {
        return await read(
          joinPath(electron.app.getPath("home"), ".mikiko", "v2", "sub2api.json"),
          "utf-8",
        );
      } catch {
        return "";
      }
    });
    expect(configJson).toContain(E2E_USERNAME);
    expect(configJson).not.toMatch(/kc-|refresh_token"\s*:\s*"[A-Za-z0-9_-]{20,}/);

    // I 回归：登录后模型选择器非空（真实账号密钥同步为 MikikoCC 供应商）。
    const modelTrigger = await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
    await modelTrigger.waitForDisplayed({ timeout: 60_000 });
    await modelTrigger.click();
    await $(`[data-testid="${TID_CHAT_MODEL_SELECT_ITEM}"]`).waitForDisplayed({
      timeout: 60_000,
    });
    const modelItems = await $$(`[data-testid="${TID_CHAT_MODEL_SELECT_ITEM}"]`);
    expect(modelItems.length).toBeGreaterThan(0);
    await browser.keys("Escape");

    void readFile; // 保持 Node 侧导入用于潜在排障（无断言依赖）。
  });
});
