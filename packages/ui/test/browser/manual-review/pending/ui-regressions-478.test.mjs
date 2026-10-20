import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer as createPortReservation } from "node:net";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const directory = "/packages/ui/test/browser/manual-review/pending/";
const entry = `${directory}ui-regressions-478.fixture.tsx`;
const state = `${directory}ui-regressions-478.state.fixture.tsx`;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/ui-regressions-478");
const exportsBySource = {
  "@/hooks/useSettingService.js": "useSettings",
  "@/hooks/useModelSelectionView.js": "useModelSelectionView",
  "@/hooks/useChatGPTAccounts.js": "useChatGPTAccounts, buildChatGPTAccountLabels",
  "@/store/TabStoreProvider.js": "Pass as TabStoreProvider, useTabStore",
  "@/store/StoreProvider.js": "Pass as StoreProvider, useZCodeStore",
  "@/root/DiffsWorkerPoolProvider.js": "Pass as DiffsWorkerPoolProvider",
  "@/AssistantCodeCommentFeatureProvider.js": "Pass as AssistantCodeCommentFeatureProvider",
  "@/settings/CodingPlanUpgradeDialogProvider.js": "Pass as CodingPlanUpgradeDialogProvider",
  "@/request-security-edition/index.js": "Empty as RequestSecurityHost",
  "@/WorkspaceHeader.js": "Empty as WorkspaceHeader",
  "@/v4/V4WorkspaceChatArea.js": "Empty as V4WorkspaceChatArea",
  "@/app-shell/AnimatedTerminalPanel.js": "Empty as AnimatedTerminalPanel",
  "@/theme-skins/AppWallpaperLayer.js": "Empty as AppWallpaperLayer",
  "@/useTheme.js": "noop as useTheme",
  "@/app-shell/useWorkspaceShellZCodeState.js": "useWorkspaceShellZCodeState",
  "@/hooks/useWorkspaceActiveTaskState.js": "useWorkspaceActiveTaskState",
  "@/hooks/useWorkspaceProviderConfigFile.js": "useWorkspaceProviderConfigFile",
  "@/hooks/useGitRepository.js": "useGitRepository",
  "@/git-branch-switcher/display.js": "getGitDirtyFileCount",
  "@/app-shell/useAnimatedResizablePanel.js": "useAnimatedResizablePanel",
  "@/app-shell/useTaskSidePaneMemoryBridge.js": "useTaskSidePaneMemoryBridge",
  "@/browser-use/useBrowserScreenshotSurfaceRequest.js":
    "useBrowserScreenshotSurfaceRequest, noop as findScreenshotSurfaceTabForRender",
  "@/hooks/useAppPanels.js": "useAppPanels",
  "@/shortcuts/useShortcutBindings.js": "noop as useShortcutCommandLabel",
  "@/settings/VoiceModelCardList.js": "Empty as VoiceModelCardList",
  "@/settings/VoiceDevicePermissionCard.js": "Empty as VoiceDevicePermissionCard",
};
let server, browser, origin;
const evidence = [];
before(async () => {
  await mkdir(artifacts, { recursive: true });
  const reservation = createPortReservation();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "isolated-ui-regression-ports",
        enforce: "pre",
        resolveId(source, importer) {
          // Root/composer/pane/menus remain real. Only unrelated application ports and heavy content are fixtures.
          const isTarget = /\/(SessionWindowRoot|VoiceInputSettingsSection)\.tsx$/u.test(
            importer ?? "",
          );
          const key = source.replace(`${root}packages/ui/src/`, "@/");
          const names = isTarget ? exportsBySource[key] : undefined;
          if (names) return `\0ui-regression:${names}`;
          if (key === "@/settings/PluginStorePage.js") return "\0ui-regression:PluginStorePage";
          if (source === "./PluginUiSidePane.js" && importer?.endsWith("/plugin-ui/index.ts"))
            return "\0ui-regression:PluginUiSidePane";
        },
        load(id) {
          if (id.startsWith("\0ui-regression:"))
            return `export { ${id.slice("\0ui-regression:".length)} } from ${JSON.stringify(state)};`;
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/fixture?")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await vite.transformIndexHtml(
                request.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: null },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await writeFile(join(artifacts, "evidence.json"), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await server?.close();
});
async function pageFor(query) {
  const page = await browser.newPage({ viewport: { width: 1250, height: 860 } });
  const errors = [],
    blocked = [];
  const failed = Promise.withResolvers();
  failed.promise.catch(() => {});
  page.on("pageerror", (error) => {
    errors.push(error.message);
    failed.reject(error);
  });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  page.setDefaultTimeout(15000);
  await page.goto(`${origin}fixture?${query}`, { timeout: 120000 });
  try {
    await Promise.race([page.locator("#root > *").first().waitFor(), failed.promise]);
  } catch (error) {
    await page.close();
    throw error;
  }
  return { page, errors, blocked };
}

for (const platform of ["mac", "windows", "linux"])
  test(`UI4 ${platform}: one visible hit target for each action`, async () => {
    const { page, errors, blocked } = await pageFor(`mode=top&platform=${platform}`);
    try {
      const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
      await toggle.waitFor();
      assert.equal(await toggle.count(), 1);
      assert.equal(await page.getByRole("button", { name: "Go back", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Go forward", exact: true }).count(), 1);
      await toggle.click();
      await page.getByRole("button", { name: "Go back", exact: true }).click();
      await page.getByRole("button", { name: "Go forward", exact: true }).click();
      assert.equal(
        await page.getByTestId("fixture-events").textContent(),
        '["toggle","back","forward"]',
      );
      await page.screenshot({ path: join(artifacts, `UI4-${platform}.png`) });
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      evidence.push({ case: `UI4-${platform}`, actions: 3, counts: [1, 1, 1], errors, blocked });
    } finally {
      await page.close();
    }
  });

for (const [theme, locale] of [
  ["light", "en-US"],
  ["dark", "zh-CN"],
])
  test(`UI7 ${theme}/${locale}: real conversation menu and local lowest-effort selection`, async () => {
    const { page, errors, blocked } = await pageFor(`mode=voice&theme=${theme}&locale=${locale}`);
    try {
      const trigger = page.getByTestId("chat-model-select-trigger");
      await trigger.click();
      await page.getByTestId("composer-provider-trigger").click();
      await page.getByRole("menuitemradio", { name: /Mikiko Relay/u }).click();
      await page.getByRole("menuitemradio", { name: "relay-two", exact: true }).click();
      const writes = await page.evaluate(() => window.__uiSettingWrites);
      assert.equal(writes.length, 2, "provider selection and model selection each persist once");
      assert.equal(writes.at(-1).voiceCleanupSelection.providerId, "relay-provider");
      assert.equal(writes.at(-1).voiceCleanupSelection.modelId, "relay-two");
      assert.equal(writes.at(-1).voiceCleanupSelection.reasoningLevel, "low");
      assert.ok(
        writes.every((write) => Object.keys(write).length === 1 && write.voiceCleanupSelection),
      );
      assert.equal(await page.locator('input[type="range"]').count(), 0);
      await page.screenshot({ path: join(artifacts, `UI7-${theme}.png`) });
      await page.keyboard.press("Escape");
      await trigger.getByText("relay-two", { exact: true }).waitFor();
      await page.screenshot({
        path: join(artifacts, `UI7-${theme}-selected.png`),
        animations: "disabled",
      });
      await page.getByRole("switch").click();
      assert.equal(await trigger.isDisabled(), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      evidence.push({ case: `UI7-${theme}`, writes, errors, blocked });
    } finally {
      await page.close();
    }
  });

test("UI8: actual session-window root lists plugin and opens its local market and plugin tabs", async () => {
  const { page, errors, blocked } = await pageFor("mode=session");
  const other = await pageFor("mode=session");
  try {
    // Side pane 保留隐藏 tab 的 DOM；交互和数量只针对当前可见 launcher。
    const plugin =
      '[role="tabpanel"][data-state="active"] [data-side-pane-open-tab-item="plugin-ui:fixture@personal/panel"]';
    await page.locator(plugin).waitFor();
    await other.page.locator(plugin).waitFor();
    await page.screenshot({ path: join(artifacts, "UI8-session-launcher.png") });
    await page.getByTestId("side-pane-plugin-market").click();
    await page.getByTestId("fixture-market").waitFor();
    // 在另一独立窗口启动插件；第一个窗口的市场必须保持原位，验证各自的 pane owner。
    assert.equal(await other.page.locator(plugin).count(), 1);
    await other.page.locator(plugin).click();
    await other.page.getByTestId("fixture-plugin-panel").waitFor();
    const requests = await other.page.evaluate(() => window.__uiPanelRequests);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].workspaceIdentity, "fixture-session-window-identity");
    assert.equal(requests[0].parentSessionId, "fixture-session-window-session");
    assert.equal(await other.page.getByTestId("fixture-market").count(), 0);
    assert.equal(await page.getByTestId("fixture-market").count(), 1);
    assert.equal(await page.getByTestId("fixture-plugin-panel").count(), 0);
    await other.page.screenshot({ path: join(artifacts, "UI8-session-plugin.png") });
    assert.deepEqual([...errors, ...other.errors], []);
    assert.deepEqual([...blocked, ...other.blocked], []);
    evidence.push({
      case: "UI8",
      requests,
      otherWindowUntouched: true,
      errors,
      blocked,
      limitation:
        "Host/service ports and market/sandbox heavy content are isolated fixtures; root, provider, launcher and pane/tab UI are real.",
    });
  } finally {
    await page.close();
    await other.page.close();
  }
});
