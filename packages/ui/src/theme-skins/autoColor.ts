import type { ThemeSkinTokenMap } from "@zcode/shared";
import { THEME_SKIN_TOKEN_ALLOWLIST } from "@zcode/shared";
import {
  Hct,
  QuantizerCelebi,
  Score,
  TonalPalette,
  hexFromArgb,
} from "@material/material-color-utilities";

/**
 * 一键配色（specs/ui/theme-skins.md §8）：按壁纸自动生成明暗两套完整配色。
 * 算法 = Google Material You 动态取色（Android 12+ 壁纸主题同款，
 * @material/material-color-utilities）：
 *   壁纸像素 → Celebi 量化 + Score 评分 → source color → HCT 色相生成
 *   neutral / neutralVariant / primary 三支色调调色板 → 按色调位映射 33 token。
 * 色调位对齐 mikiko 基础主题的既有取值（浅色 background=N98、深色 background=N8 等），
 * MD3 色调位自带明暗可读性（tone 差保证对比度）。
 */

/** 像素（ARGB int 数组）→ source color。导出供测试注入合成像素。 */
export function extractSourceColorFromPixels(pixels: number[]): number {
  const population = QuantizerCelebi.quantize(pixels, 128);
  const ranked = Score.score(population);
  if (ranked.length === 0) {
    throw new Error("no colors extracted from wallpaper");
  }
  return ranked[0]!;
}

/** dataURL 图片 → 缩放 canvas 像素 → source color（dataURL 同源，无 canvas 污染）。 */
export async function extractSourceColorFromDataUrl(dataUrl: string): Promise<number> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("wallpaper image failed to decode"));
    element.src = dataUrl;
  });
  // 64×64 足够量化取样（Celebi 复杂度 O(像素)，全尺寸 5K 图会卡渲染线程数秒）。
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas 2d context unavailable");
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  const pixels: number[] = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    pixels.push(
      ((data[offset]! << 24) |
        (data[offset + 1]! << 16) |
        (data[offset + 2]! << 8) |
        data[offset + 3]!) >>>
        0,
    );
  }
  return extractSourceColorFromPixels(pixels);
}

/**
 * CSS 渐变壁纸 → source color。canvas fillStyle 只支持单层背景，
 * 取顶层逗号分割的最后一层（基础 linear-gradient 底色）填充后采样。
 */
export async function extractSourceColorFromCss(css: string): Promise<number> {
  const layers = css.split(/,(?![^()]*\))/);
  const baseLayer = (layers[layers.length - 1] ?? css).trim();
  const width = 256;
  const height = 144;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas 2d context unavailable");
  context.fillStyle = "#000000";
  const assigned = (context.fillStyle = baseLayer);
  if (assigned !== baseLayer && assigned !== "#000000") {
    // Chromium 规范化少数合法值；两者都不匹配才视为非法表达式。
    throw new Error("wallpaper css layer is not a paintable color expression");
  }
  context.fillRect(0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const pixels: number[] = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    pixels.push(
      ((data[offset]! << 24) |
        (data[offset + 1]! << 16) |
        (data[offset + 2]! << 8) |
        data[offset + 3]!) >>>
        0,
    );
  }
  return extractSourceColorFromPixels(pixels);
}

function hexOf(argb: number): string {
  return hexFromArgb(argb).slice(0, 7).toLowerCase();
}

function rgbaOf(argb: number, alpha: number): string {
  const r = (argb >> 16) & 0xff;
  const g = (argb >> 8) & 0xff;
  const b = argb & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

/**
 * source color → 明暗两套完整 token 集。
 * 色调位（tone）刻意对齐 mikiko 基础主题（styles.css .theme-mikiko-*）的明度取值：
 * 浅色 background 98 / 深色 background 8、卡片 99/20、文字 12/88 等，
 * 让自动配色保持产品原生密度与可读性，只改变色相与点缀色。
 */
export function buildAutoColorTokenMaps(sourceArgb: number): {
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
} {
  const sourceHct = Hct.fromInt(sourceArgb);
  const hue = sourceHct.hue;
  // 低饱和壁纸（灰白/纯黑照片）chroma 兜底到 24，保证按钮有点缀色；过高则收敛到 48。
  const primaryChroma = Math.max(24, Math.min(48, sourceHct.chroma));
  const neutral = TonalPalette.fromHueAndChroma(hue, 4);
  const neutralVariant = TonalPalette.fromHueAndChroma(hue, 8);
  const primary = TonalPalette.fromHueAndChroma(hue, primaryChroma);

  const light: ThemeSkinTokenMap = {
    "--color-background": hexOf(neutral.tone(98)),
    "--color-background-win-alt": hexOf(neutral.tone(90)),
    "--color-header": hexOf(neutral.tone(97)),
    "--color-panel": hexOf(neutral.tone(97)),
    "--color-sidebar": hexOf(neutral.tone(95)),
    "--color-card": hexOf(neutral.tone(99)),
    "--color-popover": hexOf(neutral.tone(99)),
    "--color-popover-header": hexOf(neutral.tone(96)),
    "--color-menu": hexOf(neutral.tone(99)),
    "--color-menu-hover": hexOf(neutral.tone(95)),
    "--color-toast": hexOf(neutral.tone(99)),
    "--color-tooltip": hexOf(neutral.tone(95)),
    "--color-tooltip-tag": hexOf(neutral.tone(92)),
    "--color-tag": hexOf(neutral.tone(92)),
    "--color-tab": hexOf(neutral.tone(95)),
    "--color-tab-active": hexOf(neutral.tone(99)),
    "--color-input": hexOf(neutral.tone(100)),
    "--color-accent": hexOf(primary.tone(90)),
    "--color-brand": hexOf(primary.tone(40)),
    "--color-primary": hexOf(primary.tone(40)),
    "--color-primary-foreground": hexOf(primary.tone(100)),
    "--color-secondary": hexOf(neutralVariant.tone(80)),
    "--color-foreground": hexOf(neutral.tone(12)),
    "--color-foreground-subtle": rgbaOf(neutral.tone(30), 0.62),
    "--color-foreground-subtlest": rgbaOf(neutral.tone(40), 0.38),
    "--color-foreground-inverse": hexOf(neutral.tone(100)),
    "--color-border": rgbaOf(neutral.tone(20), 0.12),
    "--color-border-hover": rgbaOf(neutral.tone(20), 0.2),
    "--color-hover": rgbaOf(neutral.tone(20), 0.05),
    "--color-selected": rgbaOf(primary.tone(40), 0.1),
    "--color-surface": rgbaOf(neutral.tone(20), 0.035),
    "--color-surface-hover": rgbaOf(neutral.tone(20), 0.06),
  };

  const dark: ThemeSkinTokenMap = {
    "--color-background": hexOf(neutral.tone(8)),
    "--color-background-win-alt": hexOf(neutral.tone(22)),
    "--color-header": hexOf(neutral.tone(12)),
    "--color-panel": hexOf(neutral.tone(12)),
    "--color-sidebar": hexOf(neutral.tone(6)),
    "--color-card": hexOf(neutral.tone(20)),
    "--color-popover": hexOf(neutral.tone(20)),
    "--color-popover-header": hexOf(neutral.tone(14)),
    "--color-menu": hexOf(neutral.tone(20)),
    "--color-menu-hover": hexOf(neutral.tone(26)),
    "--color-toast": hexOf(neutral.tone(20)),
    "--color-tooltip": hexOf(neutral.tone(20)),
    "--color-tooltip-tag": hexOf(neutral.tone(28)),
    "--color-tag": hexOf(neutral.tone(28)),
    "--color-tab": hexOf(neutral.tone(12)),
    "--color-tab-active": hexOf(neutral.tone(8)),
    "--color-input": hexOf(neutral.tone(20)),
    "--color-accent": hexOf(primary.tone(28)),
    "--color-brand": hexOf(primary.tone(80)),
    "--color-primary": hexOf(primary.tone(80)),
    "--color-primary-foreground": hexOf(primary.tone(20)),
    "--color-secondary": hexOf(neutralVariant.tone(35)),
    "--color-foreground": hexOf(neutral.tone(88)),
    "--color-foreground-subtle": rgbaOf(neutral.tone(88), 0.6),
    "--color-foreground-subtlest": rgbaOf(neutral.tone(88), 0.36),
    "--color-foreground-inverse": hexOf(neutral.tone(10)),
    "--color-border": rgbaOf(neutral.tone(96), 0.11),
    "--color-border-hover": rgbaOf(neutral.tone(96), 0.18),
    "--color-hover": rgbaOf(neutral.tone(96), 0.05),
    "--color-selected": rgbaOf(primary.tone(70), 0.16),
    "--color-surface": rgbaOf(neutral.tone(96), 0.05),
    "--color-surface-hover": rgbaOf(neutral.tone(96), 0.09),
  };

  return { light, dark };
}

/** 供编辑器校验一键配色结果覆盖完整 curated 集。 */
export function isCompleteAutoColorMap(map: ThemeSkinTokenMap): boolean {
  return THEME_SKIN_TOKEN_ALLOWLIST.every(
    (name) => typeof map[name] === "string" && map[name].length > 0,
  );
}

/**
 * 编辑器一键配色入口：按当前壁纸形态（暂存图 / 已存库内图 / CSS 渐变）解析出
 * source color。图片必须经 main 读库内副本转 dataURL（themepack URL 直接进
 * canvas 会因跨域污染无法 getImageData）。
 */
export async function resolveWallpaperSourceColor(options: {
  wallpaper:
    | { mode: "none" }
    | { mode: "css"; css: string }
    | { mode: "image"; stagedPath: string | null; fromExisting: boolean };
  existingWallpaperPath?: string;
  readWallpaperDataUrl: (path: string) => Promise<{ dataUrl?: string; error?: string }>;
}): Promise<number> {
  if (options.wallpaper.mode === "css") {
    return extractSourceColorFromCss(options.wallpaper.css);
  }
  if (options.wallpaper.mode === "none") {
    throw new Error("no wallpaper configured");
  }
  const imagePath =
    options.wallpaper.stagedPath ??
    (options.wallpaper.fromExisting ? options.existingWallpaperPath : undefined);
  if (!imagePath) {
    throw new Error("wallpaper source path unavailable");
  }
  const result = await options.readWallpaperDataUrl(imagePath);
  if (!result.dataUrl) {
    throw new Error(result.error ?? "failed to read wallpaper");
  }
  return extractSourceColorFromDataUrl(result.dataUrl);
}
