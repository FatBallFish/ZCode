import { describe, expect, it } from "vitest";
import { argbFromHex } from "@material/material-color-utilities";
import { validateThemeSkinTokenMap } from "@zcode/shared";
import {
  buildAutoColorTokenMaps,
  extractSourceColorFromPixels,
  isCompleteAutoColorMap,
} from "../src/theme-skins/autoColor.js";

/** sRGB 相对亮度 → WCAG 对比度（用于断言自动配色的可读性下限）。 */
function contrastRatio(a: string, b: string): number {
  const channel = (hex: string) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  };
  const luminance = (hex: string) => {
    const [r, g, b] = channel(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function solidPixels(hex: string, count = 512): number[] {
  const argb = argbFromHex(hex);
  return new Array<number>(count).fill(argb);
}

describe("theme skin auto color extraction", () => {
  it("extracts the dominant color from synthetic pixels", () => {
    // 主体蓝色 + 少量白色噪点，评分应选中蓝色系源色。
    const pixels = [...solidPixels("#1d4fd7", 480), ...solidPixels("#ffffff", 32)];
    const source = extractSourceColorFromPixels(pixels);
    const blue = argbFromHex("#1d4fd7");
    const sourceHueDistance = Math.abs(((source >> 16) & 0xff) - ((blue >> 16) & 0xff));
    expect(sourceHueDistance).toBeLessThan(32);
  });

  it("returns a finite source color even for empty pixel input (Celebi falls back)", () => {
    // canvas 像素恒非空，这里只断言退化输入不崩溃且结果确定。
    const source = extractSourceColorFromPixels([]);
    expect(Number.isFinite(source)).toBe(true);
    expect(extractSourceColorFromPixels([])).toBe(source);
  });
});

describe("theme skin auto color mapping", () => {
  const blueMaps = buildAutoColorTokenMaps(argbFromHex("#1d4fd7"));
  const orangeMaps = buildAutoColorTokenMaps(argbFromHex("#d97706"));

  it("produces complete, valid token maps for both modes", () => {
    for (const map of [blueMaps.light, blueMaps.dark, orangeMaps.light, orangeMaps.dark]) {
      expect(isCompleteAutoColorMap(map)).toBe(true);
      expect(validateThemeSkinTokenMap(map).ok).toBe(true);
    }
  });

  it("is deterministic for the same source color", () => {
    expect(buildAutoColorTokenMaps(argbFromHex("#1d4fd7"))).toEqual(blueMaps);
  });

  it("keeps readable contrast between text and surfaces in both modes", () => {
    for (const maps of [blueMaps, orangeMaps]) {
      expect(
        contrastRatio(maps.light["--color-foreground"]!, maps.light["--color-background"]!),
      ).toBeGreaterThan(4.5);
      expect(
        contrastRatio(maps.dark["--color-foreground"]!, maps.dark["--color-background"]!),
      ).toBeGreaterThan(4.5);
      // 主按钮文本对主按钮底色（MD3 tone 40/100 与 80/20 组合，下限 3）。
      expect(
        contrastRatio(maps.light["--color-primary-foreground"]!, maps.light["--color-primary"]!),
      ).toBeGreaterThan(3);
      expect(
        contrastRatio(maps.dark["--color-primary-foreground"]!, maps.dark["--color-primary"]!),
      ).toBeGreaterThan(3);
    }
  });

  it("derives different accents from different wallpaper hues", () => {
    expect(blueMaps.light["--color-accent"]).not.toBe(orangeMaps.light["--color-accent"]);
    expect(blueMaps.dark["--color-brand"]).not.toBe(orangeMaps.dark["--color-brand"]);
  });

  it("falls back to a colored primary for low-chroma wallpapers", () => {
    // 近灰色壁纸：chroma 兜底 24，主按钮仍应带明显色度（与中性背景拉开）。
    const grayMaps = buildAutoColorTokenMaps(argbFromHex("#9a9a9a"));
    expect(grayMaps.light["--color-primary"]).not.toBe(grayMaps.light["--color-background"]);
    expect(
      contrastRatio(
        grayMaps.light["--color-primary-foreground"]!,
        grayMaps.light["--color-primary"]!,
      ),
    ).toBeGreaterThan(3);
  });
});
