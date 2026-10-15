/**
 * 主题皮肤（specs/ui/theme-skins.md）：叠加在基础主题（mikiko-light/dark）之上的
 * 运行时 token 覆盖 + 可选壁纸层。皮肤必须同时提供 light 与 dark 两套 token。
 */

/** 皮肤可覆盖的 CSS 自定义属性映射（键必须在 THEME_SKIN_TOKEN_ALLOWLIST 内）。 */
export type ThemeSkinTokenMap = Record<string, string>;

export type ThemeSkinWallpaperFit = "cover" | "contain";
export type ThemeSkinMode = "light" | "dark";

export interface ThemeSkinWallpaperCommon {
  fit: ThemeSkinWallpaperFit;
  /** 壁纸模糊半径（px），0-24。 */
  blurPx: number;
  /** 浅色模式压暗（0-100）；浅色用白纱保证文本可读。 */
  dimPercentLight: number;
  /** 深色模式压暗（0-100）。 */
  dimPercentDark: number;
}

/** 内置皮肤 / 自定义皮肤的 CSS 渐变壁纸。 */
export interface ThemeSkinCssWallpaper extends ThemeSkinWallpaperCommon {
  kind: "css";
  /** 完整 background 简写兼容值（linear-gradient/radial-gradient 组合）。 */
  css: string;
}

/** theme.json（磁盘）里的图片壁纸：库目录内相对文件名。 */
export interface ThemeSkinImageFileWallpaper extends ThemeSkinWallpaperCommon {
  kind: "image";
  file: string;
}

/** 运行态（localStorage/广播）里的图片壁纸：themepack:// URL。 */
export interface ThemeSkinImageRuntimeWallpaper extends ThemeSkinWallpaperCommon {
  kind: "image";
  url: string;
}

/** .mikikotheme 导出文件里的图片壁纸：dataURI 内嵌。 */
export interface ThemeSkinImageExportWallpaper extends ThemeSkinWallpaperCommon {
  kind: "image";
  dataUrl: string;
}

export type ThemeSkinWallpaper =
  | ThemeSkinCssWallpaper
  | ThemeSkinImageFileWallpaper
  | ThemeSkinImageRuntimeWallpaper
  | ThemeSkinImageExportWallpaper;

/** 内置皮肤定义（纯数据常量，不落盘；名称文案在 UI 层 i18n）。 */
export interface BuiltinThemeSkin {
  id: string;
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
  wallpaper?: ThemeSkinCssWallpaper;
}

/**
 * 运行态皮肤：token 全量内联（不依赖磁盘文件存在），壁纸图片用 themepack URL。
 * localStorage "mikiko-theme-skin" 与 store 广播都承载该结构（防启动闪烁 + 跨窗口同步）。
 */
export interface ThemeSkinRuntime {
  id: string;
  name: string;
  /** 内置皮肤不可删除、编辑保存时自动创建副本。 */
  builtin: boolean;
  description?: string;
  author?: string;
  version?: string;
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
  wallpaper?: ThemeSkinCssWallpaper | ThemeSkinImageRuntimeWallpaper;
}

/** theme.json（磁盘）结构：自定义/导入皮肤。 */
export interface ThemeSkinRecord {
  format: "mikiko-theme-skin-record";
  formatVersion: 1;
  id: string;
  name: string;
  description?: string;
  author?: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
  wallpaper?: ThemeSkinCssWallpaper | ThemeSkinImageFileWallpaper;
}

/** .mikikotheme（导入/导出）文件结构。 */
export interface ThemeSkinExportFile {
  format: "mikiko-theme-skin";
  formatVersion: 1;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
  wallpaper?: ThemeSkinCssWallpaper | ThemeSkinImageExportWallpaper;
}

/** 设置页「已安装皮肤」列表项（main listInstalled 返回；含壁纸绝对路径供 URL 构造）。 */
export interface ThemeSkinListItem {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version: string;
  updatedAt: string;
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
  wallpaper?: ThemeSkinCssWallpaper | ThemeSkinImageFileWallpaper;
  /** 图片壁纸的库内绝对路径（无图片壁纸时为空）。 */
  wallpaperImagePath?: string;
}

export type ThemeSkinWallpaperSaveMode =
  | { mode: "none" }
  | { mode: "css"; css: string }
  | { mode: "image"; stagedPath: string }
  | { mode: "keep-image" };

/** renderer → main 保存自定义皮肤载荷（id 为空 = 新建；builtin 皮肤一律走新建副本）。 */
export interface ThemeSkinSavePayload {
  id?: string;
  name: string;
  description?: string;
  light: ThemeSkinTokenMap;
  dark: ThemeSkinTokenMap;
  wallpaper: ThemeSkinWallpaperSaveMode & ThemeSkinWallpaperCommon;
}
