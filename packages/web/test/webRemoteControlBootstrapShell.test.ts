import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

function readWebIndexHtml(): string {
  return readFileSync(resolve(process.cwd(), "packages/web/index.html"), "utf8");
}

function readWorkspaceFile(path: string): Buffer {
  return readFileSync(resolve(process.cwd(), path));
}

function readWorkspaceFileDataUrl(path: string, mimeType: string): string {
  return `data:${mimeType};base64,${readWorkspaceFile(path).toString("base64")}`;
}

function readCssRule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`));
  return match?.groups?.body ?? "";
}

function createBootstrapDocument(theme: "mikiko-dark" | "mikiko-light"): JSDOM {
  return new JSDOM(readWebIndexHtml(), {
    beforeParse(window) {
      window.localStorage.setItem("mikiko-theme", theme);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false }),
      });
    },
    runScripts: "dangerously",
    url: "https://zcode.example/remote",
  });
}

describe("web remote control bootstrap shell", () => {
  it("内嵌与桌面 App 同源的浏览器标签图标", () => {
    const html = readWebIndexHtml();
    const document = new JSDOM(html).window.document;
    // Mikiko 内嵌 x-icon 格式 base64 图标（资产仓库已无 logo/icons 目录）。
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(icon?.getAttribute("type")).toBe("image/png");
    expect(icon?.href.startsWith("data:image/x-icon;base64,")).toBe(true);
    expect(icon?.getAttribute("sizes")).toBe("32x32");
    expect(readWorkspaceFile("packages/web/public/favicon.ico").length).toBeGreaterThan(0);
  });

  it("预渲染 loading 容器自身兜底主题背景，避免全局透明 body 露出白底", () => {
    const html = readWebIndexHtml();
    const loadingRule = readCssRule(html, ".zcode-boot-loading");

    expect(loadingRule).toContain("background: var(--zcode-bootstrap-bg");
    expect(loadingRule).toContain("#0f172a");
  });

  it.each([
    ["mikiko-dark", "dark", "#161616"],
    ["mikiko-light", "light", "#f8f8f8"],
  ] as const)(
    "在业务 bundle 执行前把 %s 同步到浏览器主题表面",
    (storedTheme, resolvedTheme, expectedColor) => {
      const dom = createBootstrapDocument(storedTheme);
      const { document } = dom.window;

      expect(document.documentElement.getAttribute("data-zcode-browser-theme-surface")).toBe(
        resolvedTheme,
      );
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        expectedColor,
      );
      expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
        resolvedTheme,
      );

      dom.window.close();
    },
  );

  it("Web 根表面以语义背景覆盖 Electron 透明根背景", () => {
    const html = readWebIndexHtml();
    const browserSurfaceRule = readCssRule(html, "html[data-zcode-browser-theme-surface] #root");

    expect(html).toContain("html[data-zcode-browser-theme-surface] body");
    expect(browserSurfaceRule).toContain("background: var(--color-background");
    expect(browserSurfaceRule).toContain("!important");
  });
});
