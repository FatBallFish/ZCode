import type {
  BuiltinThemeSkin,
  ThemeSkinCssWallpaper,
  ThemeSkinImageRuntimeWallpaper,
  ThemeSkinListItem,
  ThemeSkinMode,
  ThemeSkinRecord,
  ThemeSkinRuntime,
  ThemeSkinWallpaper,
  ThemeSkinWallpaperCommon,
} from "./types.js";
import { THEME_SKIN_TOKEN_ALLOWLIST } from "./tokens.js";

/** 皮肤壁纸图片的特权协议（desktop main 注册；只放行 theme-skins 根目录内图片）。 */
export const THEME_SKIN_SCHEME = "themepack";

export function buildThemepackAssetUrl(absolutePath: string): string {
  return `${THEME_SKIN_SCHEME}://local/asset?path=${encodeURIComponent(absolutePath)}`;
}

export const DEFAULT_THEME_SKIN_WALLPAPER: ThemeSkinWallpaperCommon = {
  fit: "cover",
  blurPx: 0,
  dimPercentLight: 46,
  dimPercentDark: 12,
};

export function clampThemeSkinWallpaperCommon(
  input: Partial<ThemeSkinWallpaperCommon>,
): ThemeSkinWallpaperCommon {
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const parsed =
      typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    fit: input.fit === "contain" ? "contain" : "cover",
    blurPx: clamp(input.blurPx, 0, 24, DEFAULT_THEME_SKIN_WALLPAPER.blurPx),
    dimPercentLight: clamp(
      input.dimPercentLight,
      0,
      100,
      DEFAULT_THEME_SKIN_WALLPAPER.dimPercentLight,
    ),
    dimPercentDark: clamp(
      input.dimPercentDark,
      0,
      100,
      DEFAULT_THEME_SKIN_WALLPAPER.dimPercentDark,
    ),
  };
}

/** runtime 构造：内置皮肤（名称由 UI 层 i18n 解析后传入）。 */
export function buildRuntimeFromBuiltin(builtin: BuiltinThemeSkin, name: string): ThemeSkinRuntime {
  return {
    id: builtin.id,
    name,
    builtin: true,
    light: { ...builtin.light },
    dark: { ...builtin.dark },
    ...(builtin.wallpaper ? { wallpaper: { ...builtin.wallpaper } } : {}),
  };
}

/** runtime 构造：磁盘列表项（图片壁纸解析为 themepack URL）。 */
export function buildRuntimeFromListItem(item: ThemeSkinListItem): ThemeSkinRuntime {
  const wallpaper: ThemeSkinCssWallpaper | ThemeSkinImageRuntimeWallpaper | undefined =
    item.wallpaper?.kind === "css"
      ? { ...item.wallpaper }
      : item.wallpaper?.kind === "image" && item.wallpaperImagePath
        ? {
            kind: "image",
            url: buildThemepackAssetUrl(item.wallpaperImagePath),
            ...clampThemeSkinWallpaperCommon(item.wallpaper),
          }
        : undefined;
  return {
    id: item.id,
    name: item.name,
    builtin: false,
    ...(item.description ? { description: item.description } : {}),
    ...(item.author ? { author: item.author } : {}),
    ...(item.version ? { version: item.version } : {}),
    light: { ...item.light },
    dark: { ...item.dark },
    ...(wallpaper ? { wallpaper } : {}),
  };
}

/** theme.json 记录 → 列表项（补壁纸绝对路径）。 */
export function buildListItemFromRecord(
  record: ThemeSkinRecord,
  skinDir: string,
): ThemeSkinListItem {
  const wallpaperImagePath =
    record.wallpaper?.kind === "image" ? `${skinDir}/${record.wallpaper.file}` : undefined;
  return {
    id: record.id,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    ...(record.author ? { author: record.author } : {}),
    version: record.version,
    updatedAt: record.updatedAt,
    light: { ...record.light },
    dark: { ...record.dark },
    ...(record.wallpaper ? { wallpaper: { ...record.wallpaper } } : {}),
    ...(wallpaperImagePath ? { wallpaperImagePath } : {}),
  };
}

// ---------------------------------------------------------------------------
// DOM/CSS 变量计算（运行时应用与设置页预览共用同一实现）
// ---------------------------------------------------------------------------

/**
 * 壁纸激活时的透显包装（specs/ui/theme-skins.md §4）：窗口面半透明让壁纸透出，
 * 内容面保持较高不透明度保证可读。值可能是 hex/rgb，color-mix 统一处理。
 */
const WINDOW_SURFACE_ALPHA: Record<string, number> = {
  "--color-background": 0.58,
  "--color-background-win-alt": 0.58,
  "--color-sidebar": 0.6,
  "--color-header": 0.62,
  "--color-panel": 0.62,
};

const CONTENT_SURFACE_ALPHA: Record<string, number> = {
  "--color-card": 0.9,
  "--color-popover": 0.95,
  "--color-popover-header": 0.95,
  "--color-menu": 0.95,
  "--color-toast": 0.95,
  "--color-tooltip": 0.95,
  "--color-tooltip-tag": 0.92,
  "--color-tag": 0.92,
  "--color-tab": 0.92,
  "--color-tab-active": 0.95,
  "--color-input": 0.9,
};

function withTranslucency(name: string, value: string): string {
  const alpha = WINDOW_SURFACE_ALPHA[name] ?? CONTENT_SURFACE_ALPHA[name];
  if (alpha === undefined || value === "transparent") return value;
  return `color-mix(in srgb, ${value} ${Math.round(alpha * 100)}%, transparent)`;
}

export interface ThemeSkinCssVarSet {
  /** 皮肤 token 覆盖（已按模式选取并做透显包装）。 */
  tokens: Record<string, string>;
  /** 完整 background 值：url(...) center/fit 或渐变 css；无壁纸时缺省。 */
  wallpaperLayer?: string;
  /** blur 半径（px 字符串）。 */
  wallpaperBlurPx: number;
  /** 当前模式的压暗纱颜色。 */
  wallpaperVeil?: string;
}

function wallpaperVeilColor(mode: ThemeSkinMode, dimPercent: number): string {
  const alpha = Math.round(dimPercent) / 100;
  return mode === "dark"
    ? `rgba(8, 8, 10, ${alpha.toFixed(3)})`
    : `rgba(250, 250, 252, ${alpha.toFixed(3)})`;
}

function buildWallpaperLayer(wallpaper: ThemeSkinWallpaper): string | undefined {
  if (wallpaper.kind === "css") return wallpaper.css;
  if (wallpaper.kind === "image" && "url" in wallpaper && wallpaper.url) {
    return `url("${wallpaper.url}") center / ${wallpaper.fit === "contain" ? "contain" : "cover"} no-repeat`;
  }
  return undefined;
}

/**
 * 计算皮肤在指定模式下应设置的 CSS 变量（含壁纸变量）。
 * DOM 应用（documentElement inline style）与设置页缩略预览共用，
 * 保证「所见预览 = 实际生效」。
 */
export function computeThemeSkinCssVars(
  skin: ThemeSkinRuntime | null,
  mode: ThemeSkinMode,
): ThemeSkinCssVarSet {
  const tokenMap = skin ? (mode === "dark" ? skin.dark : skin.light) : null;
  const hasWallpaper = Boolean(skin?.wallpaper && buildWallpaperLayer(skin.wallpaper));
  const tokens: Record<string, string> = {};
  if (tokenMap) {
    for (const name of THEME_SKIN_TOKEN_ALLOWLIST) {
      const value = tokenMap[name];
      if (typeof value === "string" && value.length > 0) {
        tokens[name] = hasWallpaper ? withTranslucency(name, value) : value;
      }
    }
  }
  const result: ThemeSkinCssVarSet = { tokens, wallpaperBlurPx: 0 };
  if (skin?.wallpaper && hasWallpaper) {
    const wallpaperLayer = buildWallpaperLayer(skin.wallpaper);
    if (wallpaperLayer) result.wallpaperLayer = wallpaperLayer;
    result.wallpaperBlurPx = skin.wallpaper.blurPx;
    result.wallpaperVeil = wallpaperVeilColor(
      mode,
      mode === "dark" ? skin.wallpaper.dimPercentDark : skin.wallpaper.dimPercentLight,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// dataURL 工具（导入/导出内嵌壁纸）
// ---------------------------------------------------------------------------

const WALLPAPER_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function parseThemeSkinWallpaperDataUrl(
  dataUrl: string,
): { ok: true; mime: string; extension: string; bytes: Uint8Array } | { ok: false; error: string } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match)
    return {
      ok: false,
      error: "wallpaper dataUrl must be a base64 png/jpeg/webp image",
    };
  const mime = match[1] as "image/png" | "image/jpeg" | "image/webp";
  const base64 = match[2] as string;
  if (base64.length % 4 !== 0) return { ok: false, error: "wallpaper dataUrl base64 is malformed" };
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return { ok: true, mime, extension: WALLPAPER_MIME_EXTENSIONS[mime]!, bytes };
}

export function buildThemeSkinWallpaperDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** primary-foreground 自动对比：按相对亮度选黑/白（编辑器「主色」旋钮用）。 */
export function pickContrastForeground(hex: string): string {
  const match = /^#([\da-fA-F]{6})(?:[\da-fA-F]{2})?$/.exec(hex.trim());
  if (!match) return "#ffffff";
  const value = Number.parseInt(match[1]!, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#ffffff";
}
