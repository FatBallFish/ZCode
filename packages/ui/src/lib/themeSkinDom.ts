import type { ThemeSkinRuntime } from "@zcode/shared";
import { computeThemeSkinCssVars, sanitizeThemeSkinTokenMap } from "@zcode/shared";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

/**
 * 主题皮肤 DOM 应用管线（specs/ui/theme-skins.md §2）。
 * 皮肤 token 通过 documentElement inline style 覆盖（优先级高于 .theme-mikiko-* 类），
 * 壁纸层通过 --app-wallpaper-* 变量驱动 AppWallpaperLayer。
 * apply 先清旧变量再设新值，幂等；任何窗口重放同一结果。
 */

export const THEME_SKIN_STORAGE_KEY = "mikiko-theme-skin";
/** 皮肤激活标记（供 CSS 选择器使用的根 class）。 */
export const APP_WALLPAPER_ROOT_CLASS = "has-app-wallpaper";

const WALLPAPER_VARS = [
  "--app-wallpaper-layer",
  "--app-wallpaper-veil",
  "--app-wallpaper-blur",
] as const;

/** 上次由皮肤设置的变量名，重放/清除时逐一回收，避免残留。 */
let appliedVarNames = new Set<string>();

export function applyThemeSkinDom(skin: ThemeSkinRuntime | null, mode: "light" | "dark"): void {
  const root = document.documentElement;
  const vars = computeThemeSkinCssVars(skin, mode);
  const nextNames = new Set<string>(Object.keys(vars.tokens));

  for (const name of appliedVarNames) {
    if (!nextNames.has(name)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars.tokens)) {
    root.style.setProperty(name, value);
  }

  const hasWallpaper = Boolean(vars.wallpaperLayer);
  if (hasWallpaper) {
    root.style.setProperty("--app-wallpaper-layer", vars.wallpaperLayer!);
    root.style.setProperty("--app-wallpaper-veil", vars.wallpaperVeil ?? "transparent");
    root.style.setProperty("--app-wallpaper-blur", `${vars.wallpaperBlurPx}px`);
  } else {
    for (const name of WALLPAPER_VARS) root.style.removeProperty(name);
  }
  root.classList.toggle(APP_WALLPAPER_ROOT_CLASS, hasWallpaper);

  appliedVarNames = nextNames;
}

/** localStorage 快照结构校验（信任度低：损坏/超界一律回落 null = 默认皮肤）。 */
export function readThemeSkinSnapshotFromStorage(): ThemeSkinRuntime | null {
  const raw = readSafeLocalStorage(THEME_SKIN_STORAGE_KEY);
  if (!raw || raw === "default") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed["id"] !== "string" ||
      typeof parsed["name"] !== "string" ||
      typeof parsed["builtin"] !== "boolean"
    ) {
      return null;
    }
    const runtime: ThemeSkinRuntime = {
      id: parsed["id"],
      name: parsed["name"],
      builtin: parsed["builtin"],
      light: sanitizeThemeSkinTokenMap(parsed["light"]),
      dark: sanitizeThemeSkinTokenMap(parsed["dark"]),
    };
    const description = parsed["description"];
    const author = parsed["author"];
    const version = parsed["version"];
    if (typeof description === "string" && description) runtime.description = description;
    if (typeof author === "string" && author) runtime.author = author;
    if (typeof version === "string" && version) runtime.version = version;

    const wallpaper = parsed["wallpaper"];
    if (wallpaper && typeof wallpaper === "object" && !Array.isArray(wallpaper)) {
      const wp = wallpaper as Record<string, unknown>;
      const common = {
        fit: wp["fit"] === "contain" ? ("contain" as const) : ("cover" as const),
        blurPx: clampInt(wp["blurPx"], 0, 24, 0),
        dimPercentLight: clampInt(wp["dimPercentLight"], 0, 100, 46),
        dimPercentDark: clampInt(wp["dimPercentDark"], 0, 100, 12),
      };
      if (
        wp["kind"] === "css" &&
        typeof wp["css"] === "string" &&
        /^[-\w ,()%#.\/]+$/.test(wp["css"])
      ) {
        runtime.wallpaper = { kind: "css", css: wp["css"], ...common };
      } else if (
        wp["kind"] === "image" &&
        typeof wp["url"] === "string" &&
        wp["url"].startsWith("themepack://")
      ) {
        runtime.wallpaper = { kind: "image", url: wp["url"], ...common };
      }
    }
    return runtime;
  } catch {
    return null;
  }
}

export function writeThemeSkinSnapshotToStorage(skin: ThemeSkinRuntime | null): void {
  // "default" 常量而非 null 字符串，便于人工排查 localStorage。
  writeSafeLocalStorage(THEME_SKIN_STORAGE_KEY, skin ? JSON.stringify(skin) : "default");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 以当前 DOM 上的主题 class 解析模式（会话窗口等 hook 宿主不依赖 store）。 */
export function resolveDomThemeMode(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function reapplyThemeSkinFromSnapshot(): void {
  applyThemeSkinDom(readThemeSkinSnapshotFromStorage(), resolveDomThemeMode());
}

/** 皮肤广播/快照载荷基本形状校验（token 值在 DOM 应用前还会经 sanitize 二次过滤）。 */
export function isValidThemeSkinRuntimePayload(
  payload: unknown,
): payload is ThemeSkinRuntime | null {
  if (payload === null) return true;
  if (typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["builtin"] === "boolean" &&
    typeof candidate["light"] === "object" &&
    candidate["light"] !== null &&
    typeof candidate["dark"] === "object" &&
    candidate["dark"] !== null
  );
}

/**
 * 订阅其它窗口写入的皮肤快照（storage 事件）并重放。
 * 会话独立窗口（useTheme hook 宿主，无 store 广播）靠这里保持皮肤同步。
 */
export function subscribeToThemeSkinStorage(): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === THEME_SKIN_STORAGE_KEY) {
      reapplyThemeSkinFromSnapshot();
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
