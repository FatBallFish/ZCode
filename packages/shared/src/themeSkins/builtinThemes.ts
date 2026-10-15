import type { BuiltinThemeSkin } from "./types.js";
import {
  cobaltDark,
  cobaltLight,
  forestDark,
  forestLight,
  modeTokens,
  noirDark,
  noirLight,
  sakuraDark,
  sakuraLight,
  terracottaDark,
  terracottaLight,
} from "./builtinThemePalettes.js";

/**
 * 内置主题皮肤（specs/ui/theme-skins.md §6）。纯数据常量，不落盘；
 * 名称/描述文案由 UI 层按 id 取 i18n（settings.themeSkin.builtin.<id>.*）。
 *
 * 配色纪律：每套单一 accent、无纯黑纯白、饱和度克制、明暗两模式文本对比保持可读；
 * 派生 token（background-alt、各 *-border、terminal-bg/fg 等）由 styles.css 的
 * var() 引用链自动跟随，这里只声明 allowlist 内的主 token。
 */

/** 内置皮肤清单；顺序即设置页展示顺序，首项必须是默认皮肤。 */
export const BUILTIN_THEME_SKINS: BuiltinThemeSkin[] = [
  // 默认皮肤 = 零覆盖（产品原生 mikiko-light/dark 外观）。
  { id: "mikiko-default", light: {}, dark: {} },
  {
    id: "terracotta-paper",
    light: modeTokens(terracottaLight),
    dark: modeTokens(terracottaDark),
  },
  {
    id: "forest-study",
    light: modeTokens(forestLight),
    dark: modeTokens(forestDark),
    wallpaper: {
      kind: "css",
      css: "radial-gradient(1200px 800px at 85% 10%, rgba(88, 158, 112, 0.16), transparent 60%), radial-gradient(1000px 700px at 10% 90%, rgba(46, 102, 70, 0.18), transparent 55%), linear-gradient(160deg, #17241c, #0e1611 55%, #131f18)",
      fit: "cover",
      blurPx: 0,
      dimPercentLight: 42,
      dimPercentDark: 10,
    },
  },
  {
    id: "cobalt-ink",
    light: modeTokens(cobaltLight),
    dark: modeTokens(cobaltDark),
  },
  {
    id: "sakura-dusk",
    light: modeTokens(sakuraLight),
    dark: modeTokens(sakuraDark),
    wallpaper: {
      kind: "css",
      css: "radial-gradient(1100px 750px at 80% 8%, rgba(212, 120, 156, 0.2), transparent 60%), radial-gradient(900px 700px at 12% 92%, rgba(122, 88, 180, 0.16), transparent 55%), linear-gradient(155deg, #231722, #150f18 60%, #1d1424)",
      fit: "cover",
      blurPx: 0,
      dimPercentLight: 44,
      dimPercentDark: 8,
    },
  },
  {
    id: "terminal-noir",
    light: modeTokens(noirLight),
    dark: modeTokens(noirDark),
  },
];

export const DEFAULT_THEME_SKIN_ID = "mikiko-default";

export function findBuiltinThemeSkin(id: string): BuiltinThemeSkin | undefined {
  return BUILTIN_THEME_SKINS.find((skin) => skin.id === id);
}
