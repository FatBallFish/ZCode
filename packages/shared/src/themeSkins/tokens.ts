import type { ThemeSkinTokenMap } from "./types.js";

/**
 * 皮肤可覆盖的主 token 白名单（specs/ui/theme-skins.md §3）。
 * 派生 token（background-alt、terminal-bg/fg、各 *-border、card-selected 等）
 * 在 styles.css 内以 var() 引用这些主 token，覆盖后自动跟随。
 * 语义功能色（success/warning/destructive/diff/git/终端 ANSI/图表）不允许皮肤覆盖。
 */
export const THEME_SKIN_TOKEN_ALLOWLIST = [
  "--color-background",
  "--color-background-win-alt",
  "--color-header",
  "--color-panel",
  "--color-sidebar",
  "--color-card",
  "--color-popover",
  "--color-popover-header",
  "--color-menu",
  "--color-toast",
  "--color-tooltip",
  "--color-tooltip-tag",
  "--color-tag",
  "--color-tab",
  "--color-tab-active",
  "--color-input",
  "--color-accent",
  "--color-brand",
  "--color-primary",
  "--color-primary-foreground",
  "--color-secondary",
  "--color-foreground",
  "--color-foreground-subtle",
  "--color-foreground-subtlest",
  "--color-foreground-inverse",
  "--color-border",
  "--color-border-hover",
  "--color-hover",
  "--color-selected",
  "--color-surface",
  "--color-surface-hover",
  "--color-menu-hover",
] as const;

export type ThemeSkinTokenName = (typeof THEME_SKIN_TOKEN_ALLOWLIST)[number];

const THEME_SKIN_TOKEN_SET = new Set<string>(THEME_SKIN_TOKEN_ALLOWLIST);

/** 颜色值语法（防注入 var()/url()/花括号等）：hex / rgb(a) / hsl(a) / transparent。 */
const THEME_SKIN_COLOR_PATTERN =
  /^(?:transparent|#(?:[\da-fA-F]{3,4}|[\da-fA-F]{6}|[\da-fA-F]{8})|rgba?\(\s*[-\d.,%\s/]+\)|hsla?\(\s*[-\d.,%\s/degrAD]+\))$/;

export const THEME_SKIN_NAME_MAX_LENGTH = 60;
export const THEME_SKIN_DESCRIPTION_MAX_LENGTH = 200;
export const THEME_SKIN_EXPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const THEME_SKIN_WALLPAPER_MAX_BYTES = 15 * 1024 * 1024;
export const THEME_SKIN_WALLPAPER_BLUR_PX_MAX = 24;
export const THEME_SKIN_WALLPAPER_DIM_PERCENT_MAX = 100;
/** 自定义皮肤 id 形如 user-<rand>；内置 id 固定前缀。 */
export const THEME_SKIN_ID_PATTERN = /^[\w.-]+$/;

export function isThemeSkinTokenName(name: string): boolean {
  return THEME_SKIN_TOKEN_SET.has(name);
}

export function isThemeSkinColorValue(value: string): boolean {
  return THEME_SKIN_COLOR_PATTERN.test(value);
}

export interface ThemeSkinTokenMapValidation {
  ok: boolean;
  error?: string;
}

/** 校验 token map：键在白名单内且值是合法颜色（导入/保存统一走这里）。 */
export function validateThemeSkinTokenMap(map: unknown): ThemeSkinTokenMapValidation {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return { ok: false, error: "token map must be an object" };
  }
  for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
    if (!THEME_SKIN_TOKEN_SET.has(name)) {
      return { ok: false, error: `token not allowed: ${name}` };
    }
    if (typeof value !== "string" || !THEME_SKIN_COLOR_PATTERN.test(value)) {
      return { ok: false, error: `invalid color value for ${name}` };
    }
  }
  return { ok: true };
}

/**
 * 宽松净化（防御旧数据/损坏快照）：只保留白名单内的合法项，其余丢弃。
 * 用于 localStorage 快照读取等信任度较低的路径。
 */
export function sanitizeThemeSkinTokenMap(input: unknown): ThemeSkinTokenMap {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const result: ThemeSkinTokenMap = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (
      THEME_SKIN_TOKEN_SET.has(name) &&
      typeof value === "string" &&
      isThemeSkinColorValue(value)
    ) {
      result[name] = value;
    }
  }
  return result;
}
