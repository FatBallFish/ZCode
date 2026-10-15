import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_SKINS,
  DEFAULT_THEME_SKIN_ID,
  THEME_SKIN_TOKEN_ALLOWLIST,
  buildRuntimeFromBuiltin,
  buildThemepackAssetUrl,
  clampThemeSkinWallpaperCommon,
  computeThemeSkinCssVars,
  isThemeSkinColorValue,
  parseThemeSkinWallpaperDataUrl,
  pickContrastForeground,
  sanitizeThemeSkinTokenMap,
  themeSkinExportFileSchema,
  validateThemeSkinTokenMap,
} from "../src/themeSkins/index.js";
import type { ThemeSkinExportFile } from "../src/themeSkins/index.js";

describe("theme skins token validation", () => {
  it("accepts allowlisted tokens with plain color values", () => {
    const result = validateThemeSkinTokenMap({
      "--color-background": "#f5f3f2",
      "--color-foreground": "rgba(56, 48, 43, 0.62)",
      "--color-accent": "hsl(12, 30%, 90%)",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects tokens outside the allowlist (semantic/safety colors stay fixed)", () => {
    const result = validateThemeSkinTokenMap({
      "--color-destructive": "#ff0000",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-color values (var()/url() injection)", () => {
    expect(isThemeSkinColorValue("var(--color-brand)")).toBe(false);
    expect(isThemeSkinColorValue("url(javascript:alert(1))")).toBe(false);
    expect(isThemeSkinColorValue("#gggggg")).toBe(false);
    expect(isThemeSkinColorValue("#aabbccdd")).toBe(true);
  });

  it("sanitize drops invalid entries but keeps valid ones", () => {
    const sanitized = sanitizeThemeSkinTokenMap({
      "--color-accent": "#123456",
      "--color-success": "#00ff00",
      "--color-primary": "javascript:x",
    });
    expect(sanitized).toEqual({ "--color-accent": "#123456" });
  });
});

describe("theme skins export file schema", () => {
  const validFile: ThemeSkinExportFile = {
    format: "mikiko-theme-skin",
    formatVersion: 1,
    name: "测试皮肤",
    light: { "--color-accent": "#f6e3dc" },
    dark: { "--color-accent": "#43231a" },
    wallpaper: {
      kind: "css",
      css: "linear-gradient(160deg, #17241c, #0e1611)",
      fit: "cover",
      blurPx: 0,
      dimPercentLight: 42,
      dimPercentDark: 10,
    },
  };

  it("accepts a valid file and round-trips the token maps", () => {
    const parsed = themeSkinExportFileSchema.parse(validFile);
    expect(parsed.light["--color-accent"]).toBe("#f6e3dc");
    expect(parsed.wallpaper?.kind).toBe("css");
  });

  it("rejects files with out-of-allowlist tokens, url() wallpaper, or bad dataUrl", () => {
    expect(
      themeSkinExportFileSchema.safeParse({
        ...validFile,
        light: {
          "--color-foreground-inverse": "#fff",
          "--color-diff-added": "#0f0",
        },
      }).success,
    ).toBe(false);
    expect(
      themeSkinExportFileSchema.safeParse({
        ...validFile,
        wallpaper: {
          kind: "css",
          css: "url(https://evil.example/x.png)",
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 10,
          dimPercentDark: 10,
        },
      }).success,
    ).toBe(false);
    expect(
      themeSkinExportFileSchema.safeParse({
        ...validFile,
        wallpaper: {
          kind: "image",
          dataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 10,
          dimPercentDark: 10,
        },
      }).success,
    ).toBe(false);
  });
});

describe("theme skins wallpaper helpers", () => {
  it("parses base64 png data urls and rejects svg/oversized base64", () => {
    const png = parseThemeSkinWallpaperDataUrl("data:image/png;base64,AAAA");
    expect(png.ok).toBe(true);
    const svg = parseThemeSkinWallpaperDataUrl("data:image/svg+xml;base64,PHN2Zz4=");
    expect(svg.ok).toBe(false);
  });

  it("clamps wallpaper common settings into legal ranges", () => {
    const clamped = clampThemeSkinWallpaperCommon({
      fit: "contain",
      blurPx: 999,
      dimPercentLight: -5,
      dimPercentDark: NaN,
    });
    expect(clamped.blurPx).toBe(24);
    expect(clamped.dimPercentLight).toBe(0);
    expect(clamped.dimPercentDark).toBe(12);
  });

  it("builds themepack urls with encoded paths", () => {
    expect(buildThemepackAssetUrl("/a b/壁纸.png")).toBe(
      "themepack://local/asset?path=%2Fa%20b%2F%E5%A3%81%E7%BA%B8.png",
    );
  });
});

describe("builtin theme skins integrity", () => {
  it("starts with the default skin (zero overrides) and covers distinct families", () => {
    expect(BUILTIN_THEME_SKINS[0]?.id).toBe(DEFAULT_THEME_SKIN_ID);
    expect(BUILTIN_THEME_SKINS[0]?.light).toEqual({});
    expect(BUILTIN_THEME_SKINS[0]?.dark).toEqual({});
    expect(new Set(BUILTIN_THEME_SKINS.map((skin) => skin.id)).size).toBe(
      BUILTIN_THEME_SKINS.length,
    );
    expect(BUILTIN_THEME_SKINS.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps every builtin token inside the allowlist with valid colors in both modes", () => {
    for (const skin of BUILTIN_THEME_SKINS) {
      for (const mode of ["light", "dark"] as const) {
        const result = validateThemeSkinTokenMap(skin[mode]);
        expect(result.ok, `${skin.id}.${mode}: ${result.ok ? "" : result.error}`).toBe(true);
      }
    }
  });

  it("defines the full curated token set for non-default skins", () => {
    const curated = new Set(THEME_SKIN_TOKEN_ALLOWLIST);
    for (const skin of BUILTIN_THEME_SKINS) {
      if (skin.id === DEFAULT_THEME_SKIN_ID) continue;
      for (const mode of ["light", "dark"] as const) {
        for (const name of curated) {
          expect(skin[mode][name], `${skin.id}.${mode} missing ${name}`).toBeTruthy();
        }
      }
    }
  });
});

describe("computeThemeSkinCssVars", () => {
  it("returns no overrides and no wallpaper for null skin", () => {
    const result = computeThemeSkinCssVars(null, "dark");
    expect(Object.keys(result.tokens)).toHaveLength(0);
    expect(result.wallpaperLayer).toBeUndefined();
  });

  it("applies mode-specific tokens and translucent window surfaces when wallpaper active", () => {
    const skin = buildRuntimeFromBuiltin(
      BUILTIN_THEME_SKINS.find((skin) => skin.id === "forest-study")!,
      "Forest Study",
    );
    const darkVars = computeThemeSkinCssVars(skin, "dark");
    // 壁纸激活时两种模式的窗口面 token 都做半透明包装。
    expect(darkVars.tokens["--color-background"]).toBe(
      "color-mix(in srgb, #101713 58%, transparent)",
    );
    expect(darkVars.wallpaperLayer).toContain("linear-gradient");

    const lightVars = computeThemeSkinCssVars(skin, "light");
    expect(lightVars.tokens["--color-background"]).toContain("58%");
    expect(lightVars.tokens["--color-popover"]).toContain("95%");
    // 无壁纸皮肤的 token 保持原值不包装。
    const plain = buildRuntimeFromBuiltin(
      BUILTIN_THEME_SKINS.find((skin) => skin.id === "cobalt-ink")!,
      "Cobalt Ink",
    );
    expect(computeThemeSkinCssVars(plain, "light").tokens["--color-background"]).toBe("#f4f5f7");
    expect(computeThemeSkinCssVars(plain, "dark").tokens["--color-background"]).toBe("#10141d");
  });

  it("derives a mode-aware wallpaper veil from per-mode dim settings", () => {
    const skin = buildRuntimeFromBuiltin(
      BUILTIN_THEME_SKINS.find((skin) => skin.id === "sakura-dusk")!,
      "Sakura Dusk",
    );
    const lightVeil = computeThemeSkinCssVars(skin, "light").wallpaperVeil;
    const darkVeil = computeThemeSkinCssVars(skin, "dark").wallpaperVeil;
    expect(lightVeil).toContain("250, 250, 252");
    expect(darkVeil).toContain("8, 8, 10");
  });
});

describe("pickContrastForeground", () => {
  it("picks readable foreground for light and dark primaries", () => {
    expect(pickContrastForeground("#ffffff")).toBe("#111111");
    expect(pickContrastForeground("#1d4fd7")).toBe("#ffffff");
    expect(pickContrastForeground("#dd8663")).toBe("#111111");
  });
});
