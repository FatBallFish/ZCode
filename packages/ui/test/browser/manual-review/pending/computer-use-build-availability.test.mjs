import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as reservePort } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const directory = "/packages/ui/test/browser/manual-review/pending/";
const entry = `${directory}computer-use-build-availability.fixture.tsx`;
const state = `${directory}computer-use-build-availability.state.fixture.tsx`;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/cua-build-availability");
const evidence = [];
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  const socket = reservePort();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "cua-build-fixture-ports",
        enforce: "pre",
        resolveId(source, importer) {
          if (!importer?.endsWith("/settings/ComputerUseSection.tsx")) return;
          const key = source.replace(`${root}packages/ui/src/`, "@/");
          if (key === "@/hooks/useSettingService.js") return "\0cua-build:useSettings";
          if (key === "@/store/pluginManagementStore.js")
            return "\0cua-build:usePluginManagementStore";
        },
        load(id) {
          if (id.startsWith("\0cua-build:"))
            return `export {${id.slice("\0cua-build:".length)}} from ${JSON.stringify(state)};`;
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

for (const [mode, theme, locale] of [
  ["missing", "light", "en-US"],
  ["missing", "dark", "zh-CN"],
  ["old-os", "light", "en-US"],
  ["real", "dark", "en-US"],
]) {
  test(`UI2 ${mode}/${theme}/${locale}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [],
      external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    page.setDefaultTimeout(15000);
    try {
      await page.goto(`${origin}fixture?mode=${mode}&theme=${theme}&locale=${locale}`, {
        timeout: 120000,
      });
      if (mode === "missing") {
        await page.getByTestId("computer-use-build-unavailable").waitFor();
        assert.match(
          await page.getByTestId("computer-use-build-unavailable").innerText(),
          locale === "zh-CN" ? /不包含.*Computer Use/u : /does not include the Computer Use/u,
        );
        assert.equal(await page.getByRole("button").count(), 0);
        assert.equal(await page.getByRole("switch").count(), 0);
        await page.evaluate(() => {
          for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("focus"));
        });
        const calls = await page.evaluate(() => window.__cuaCalls);
        assert.deepEqual(calls, {
          capability: 1,
          status: 0,
          authorize: 0,
          restart: 0,
          initialize: 0,
          toggle: 0,
        });
      } else if (mode === "old-os") {
        await page
          .getByText(/macOS.*12/u)
          .first()
          .waitFor();
        assert.equal(await page.getByTestId("computer-use-build-unavailable").count(), 0);
        assert.equal((await page.evaluate(() => window.__cuaCalls)).status, 0);
      } else {
        await page.waitForFunction(() => window.__cuaCalls.status > 0);
        assert.equal(await page.getByTestId("computer-use-build-unavailable").count(), 0);
        assert.ok((await page.getByRole("switch").count()) > 0);
        assert.equal((await page.evaluate(() => window.__cuaCalls)).authorize, 0);
      }
      await page.screenshot({ path: join(artifacts, `${mode}-${theme}.png`) });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      evidence.push({
        mode,
        theme,
        locale,
        calls: await page.evaluate(() => window.__cuaCalls),
        errors,
        external,
      });
    } finally {
      await page.close();
    }
  });
}
