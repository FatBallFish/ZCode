import type { CSSProperties } from "react";
import { cn } from "@/components/lib/utils.js";
import type { ThemeSkinMode, ThemeSkinRuntime } from "@zcode/shared";
import { computeThemeSkinCssVars } from "@zcode/shared";

/**
 * 主题皮肤缩略预览（specs/ui/theme-skins.md §1）。
 * 关键点：预览容器用与运行时完全相同的 computeThemeSkinCssVars 计算 token
 * （含壁纸透显包装），保证「所见预览 = 实际生效」。
 */

/** 预览容器：按模式挂基础主题类（提供未覆盖 token 的兜底）+ 皮肤变量内联。 */
export function themeSkinPreviewStyle(
  skin: ThemeSkinRuntime | null,
  mode: ThemeSkinMode,
): CSSProperties {
  const vars = computeThemeSkinCssVars(skin, mode);
  const style: Record<string, string> = { ...vars.tokens };
  if (vars.wallpaperLayer) {
    style["--preview-wallpaper-layer"] = vars.wallpaperLayer;
    style["--preview-wallpaper-veil"] = vars.wallpaperVeil ?? "transparent";
    style["--preview-wallpaper-blur"] = `${vars.wallpaperBlurPx}px`;
  }
  return style as CSSProperties;
}

export function themeSkinPreviewClassName(mode: ThemeSkinMode, hasWallpaper = false): string {
  // 有壁纸时同步挂 has-app-wallpaper：styles.css 的基础值透显块让未覆盖 token 也半透明，
  // 保证预览与实际应用一致（specs/ui/theme-skins.md §4）。
  return [
    mode === "dark" ? "theme-mikiko-dark" : "theme-mikiko-light",
    ...(hasWallpaper ? ["has-app-wallpaper"] : []),
  ].join(" ");
}

/** 预览内的壁纸层（消费容器上的 --preview-wallpaper-* 变量）。 */
function PreviewWallpaper() {
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute"
          style={{
            inset: "calc(-1.5 * var(--preview-wallpaper-blur, 0px))",
            background: "var(--preview-wallpaper-layer, none)",
            filter: "blur(var(--preview-wallpaper-blur, 0px))",
          }}
        />
        <div
          className="absolute inset-0"
          style={{ background: "var(--preview-wallpaper-veil, transparent)" }}
        />
      </div>
    </>
  );
}

/** 管理页网格卡片缩略：迷你窗口（侧栏条 + 头部 + 对话 + 主按钮）。 */
export function ThemeSkinCardPreview({
  skin,
  mode,
  className,
}: {
  skin: ThemeSkinRuntime;
  mode: ThemeSkinMode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        themeSkinPreviewClassName(mode, Boolean(skin.wallpaper)),
        "relative h-28 w-full overflow-hidden rounded-lg border border-border bg-background",
        className,
      )}
      style={themeSkinPreviewStyle(skin, mode)}
    >
      <PreviewWallpaper />
      <div className="relative flex h-full w-full">
        {/* 侧栏条 */}
        <div className="flex w-9 shrink-0 flex-col gap-1.5 border-r border-border bg-sidebar p-1.5">
          <div className="size-3 rounded-[4px] bg-primary" />
          <div className="h-1.5 w-5 rounded-full bg-foreground-subtlest" />
          <div className="h-1.5 w-6 rounded-full bg-foreground-subtlest" />
          <div className="h-1.5 w-4 rounded-full bg-foreground-subtlest" />
        </div>
        {/* 会话区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-5 items-center gap-1 border-b border-border bg-header px-2">
            <div className="size-1.5 rounded-full bg-foreground-subtlest" />
            <div className="h-1 w-10 rounded-full bg-foreground-subtlest" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 p-2">
            <div className="ml-auto h-4 w-16 rounded-md bg-primary" />
            <div className="h-4 w-24 rounded-md border border-border bg-card" />
            <div className="flex items-center gap-1">
              <div className="h-3 w-9 rounded-[4px] bg-accent" />
              <div className="h-3 w-6 rounded-[4px] bg-secondary" />
            </div>
            <div className="flex h-5 items-center rounded-md border border-border bg-input px-1.5">
              <div className="h-1.5 w-12 rounded-full bg-foreground-subtlest" />
              <div className="ml-auto size-2.5 rounded-[3px] bg-primary" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 编辑器主预览：新建会话页 mock（品牌位 + 问候 + 输入框 + 建议胶囊）。 */
export function ThemeSkinNewSessionPreview({
  skin,
  mode,
  className,
  greeting,
  placeholder,
  suggestions,
}: {
  skin: ThemeSkinRuntime;
  mode: ThemeSkinMode;
  className?: string;
  greeting: string;
  placeholder: string;
  suggestions: string[];
}) {
  return (
    <div
      className={cn(
        themeSkinPreviewClassName(mode, Boolean(skin.wallpaper)),
        "relative h-full w-full overflow-hidden rounded-xl border border-border bg-background",
        className,
      )}
      style={themeSkinPreviewStyle(skin, mode)}
    >
      <PreviewWallpaper />
      <div className="relative flex h-full w-full flex-col">
        {/* 标题栏 */}
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-header px-3">
          <div className="size-2 rounded-full bg-foreground-subtlest" />
          <div className="size-2 rounded-full bg-foreground-subtlest" />
          <div className="h-1.5 w-24 rounded-full bg-foreground-subtlest" />
        </div>
        {/* 新建会话主体 */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
          <div className="flex size-11 items-center justify-center rounded-full bg-primary text-ui-lg font-semibold text-primary-foreground">
            M
          </div>
          <div className="space-y-1.5 text-center">
            <div className="text-ui-lg font-semibold text-foreground">{greeting}</div>
            <div className="text-ui-sm text-foreground-subtle">{placeholder}</div>
          </div>
          {/* 输入框 */}
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-2.5 shadow-sm">
            <div className="flex h-7 items-center rounded-lg border border-border bg-input px-2.5">
              <div className="h-1.5 w-28 rounded-full bg-foreground-subtlest" />
              <div className="ml-auto flex size-5 items-center justify-center rounded-[5px] bg-primary">
                <div className="size-1.5 rounded-[2px] bg-primary-foreground" />
              </div>
            </div>
          </div>
          {/* 建议胶囊 */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {suggestions.map((label) => (
              <div
                key={label}
                className="rounded-md bg-accent px-2.5 py-1 text-ui-xs text-foreground"
              >
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
