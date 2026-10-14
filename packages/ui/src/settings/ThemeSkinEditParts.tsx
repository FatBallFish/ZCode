import { ImagePlus, X } from "lucide-react";
import type { ThemeSkinTokenMap } from "@zcode/shared";
import { pickContrastForeground } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsRangeControl,
} from "@/settings/SettingsPageParts.js";

/**
 * 主题皮肤编辑器的旋钮部件（specs/ui/theme-skins.md §1）：ColorField 颜色输入与
 * 旋钮 ↔ token map 的读取/写回逻辑。从 ThemeSkinEditView 拆出以控制文件行数。
 */

export interface ColorKnobs {
  accent: string;
  primary: string;
  foreground: string;
}

const KNOB_FALLBACKS: Record<"light" | "dark", ColorKnobs> = {
  light: { accent: "#ebf4ff", primary: "#000000", foreground: "#262626" },
  dark: { accent: "#001d3d", primary: "#ffffff", foreground: "#a3a3a3" },
};

export function readKnobs(map: ThemeSkinTokenMap, mode: "light" | "dark"): ColorKnobs {
  const fallback = KNOB_FALLBACKS[mode];
  const accent = map["--color-accent"];
  const primary = map["--color-primary"];
  const foreground = map["--color-foreground"];
  return {
    accent: accent && /^#[\da-fA-F]{6}$/.test(accent) ? accent : fallback.accent,
    primary: primary && /^#[\da-fA-F]{6}$/.test(primary) ? primary : fallback.primary,
    foreground:
      foreground && /^#[\da-fA-F]{6}$/.test(foreground) ? foreground : fallback.foreground,
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

/** 写回旋钮值到 token map（含派生：主色前景自动对比、文本次级/三级透明度）。 */
export function applyKnobs(map: ThemeSkinTokenMap, knobs: ColorKnobs): ThemeSkinTokenMap {
  return {
    ...map,
    "--color-accent": knobs.accent,
    "--color-primary": knobs.primary,
    "--color-primary-foreground": pickContrastForeground(knobs.primary),
    "--color-foreground": knobs.foreground,
    "--color-foreground-subtle": hexToRgba(knobs.foreground, 0.62),
    "--color-foreground-subtlest": hexToRgba(knobs.foreground, 0.38),
  };
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsRow
      label={label}
      control={
        <div className="flex items-center gap-2">
          <Input
            value={value}
            aria-label={label}
            spellCheck={false}
            className="w-[104px] font-mono text-ui-sm"
            onChange={(event) => onChange(event.currentTarget.value.trim())}
          />
          <label className="relative inline-flex size-7 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border">
            <input
              type="color"
              value={/^#[\da-fA-F]{6}$/.test(value) ? value : "#000000"}
              aria-label={label}
              onChange={(event) => onChange(event.currentTarget.value)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
            <span
              aria-hidden="true"
              className="size-4 rounded-[4px]"
              style={{
                background: /^#[\da-fA-F]{6}$/.test(value) ? value : "#000000",
              }}
            />
          </label>
        </div>
      }
    />
  );
}

export type WallpaperDraft =
  | { mode: "none" }
  | { mode: "css"; css: string }
  | {
      mode: "image";
      previewUrl: string;
      stagedPath: string | null;
      fromExisting: boolean;
    };

/** 壁纸设置卡：选图/清除/取景/模糊/双模式压暗。从 ThemeSkinEditView 拆出以控制行数。 */
export function ThemeSkinWallpaperSettingsCard({
  wallpaper,
  onWallpaperChange,
  fit,
  onFitChange,
  blurPx,
  onBlurChange,
  dimLight,
  onDimLightChange,
  dimDark,
  onDimDarkChange,
  onPickWallpaper,
}: {
  wallpaper: WallpaperDraft;
  onWallpaperChange: (draft: WallpaperDraft) => void;
  fit: "cover" | "contain";
  onFitChange: (fit: "cover" | "contain") => void;
  blurPx: number;
  onBlurChange: (value: number) => void;
  dimLight: number;
  onDimLightChange: (value: number) => void;
  dimDark: number;
  onDimDarkChange: (value: number) => void;
  onPickWallpaper: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <section className="space-y-3">
      <h3 className="text-ui-base font-semibold text-foreground">
        {intl.formatMessage({ id: "settings.themeSkin.editor.wallpaperTitle" })}
      </h3>
      <SettingsGroupCard>
        {wallpaper.mode === "none" ? (
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.themeSkin.editor.wallpaper",
            })}
            description={intl.formatMessage({
              id: "settings.themeSkin.editor.wallpaperNoneDescription",
            })}
            control={
              <Button type="button" variant="outline" onClick={() => onPickWallpaper()}>
                <ImagePlus className="size-4" aria-hidden="true" />
                {intl.formatMessage({
                  id: "settings.themeSkin.editor.wallpaperPick",
                })}
              </Button>
            }
          />
        ) : (
          <>
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.themeSkin.editor.wallpaper",
              })}
              description={
                wallpaper.mode === "css"
                  ? intl.formatMessage({
                      id: "settings.themeSkin.editor.wallpaperCssDescription",
                    })
                  : undefined
              }
              control={
                <div className="flex items-center gap-2">
                  {wallpaper.mode === "image" ? (
                    <Button type="button" variant="outline" onClick={() => onPickWallpaper()}>
                      <ImagePlus className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.themeSkin.editor.wallpaperReplace",
                      })}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={intl.formatMessage({
                      id: "settings.themeSkin.editor.wallpaperClear",
                    })}
                    onClick={() => onWallpaperChange({ mode: "none" })}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              }
              detail={
                wallpaper.mode === "image" ? (
                  <div className="h-24 w-full max-w-sm overflow-hidden rounded-lg border border-border">
                    <img src={wallpaper.previewUrl} alt="" className="h-full w-full object-cover" />
                  </div>
                ) : undefined
              }
            />
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.themeSkin.editor.wallpaperFit",
              })}
              control={
                <Select
                  value={fit}
                  onValueChange={(value) => onFitChange(value === "contain" ? "contain" : "cover")}
                >
                  <SelectTrigger size="lg" className="w-[180px] min-w-0 justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cover">
                      {intl.formatMessage({
                        id: "settings.themeSkin.editor.wallpaperFit.cover",
                      })}
                    </SelectItem>
                    <SelectItem value="contain">
                      {intl.formatMessage({
                        id: "settings.themeSkin.editor.wallpaperFit.contain",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.themeSkin.editor.wallpaperBlur",
              })}
              control={
                <SettingsRangeControl
                  value={blurPx}
                  min={0}
                  max={24}
                  step={1}
                  onChange={onBlurChange}
                  valueLabel={`${blurPx}px`}
                  ariaLabel={intl.formatMessage({
                    id: "settings.themeSkin.editor.wallpaperBlur",
                  })}
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.themeSkin.editor.wallpaperDimLight",
              })}
              control={
                <SettingsRangeControl
                  value={dimLight}
                  min={0}
                  max={100}
                  step={1}
                  onChange={onDimLightChange}
                  valueLabel={`${dimLight}%`}
                  ariaLabel={intl.formatMessage({
                    id: "settings.themeSkin.editor.wallpaperDimLight",
                  })}
                />
              }
            />
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.themeSkin.editor.wallpaperDimDark",
              })}
              control={
                <SettingsRangeControl
                  value={dimDark}
                  min={0}
                  max={100}
                  step={1}
                  onChange={onDimDarkChange}
                  valueLabel={`${dimDark}%`}
                  ariaLabel={intl.formatMessage({
                    id: "settings.themeSkin.editor.wallpaperDimDark",
                  })}
                />
              }
            />
          </>
        )}
      </SettingsGroupCard>
    </section>
  );
}

/** 编辑器底部保存按钮组（内置皮肤显示「另存为副本」语义）。 */
export function ThemeSkinEditorSaveBar({
  isBuiltin,
  saving,
  onSave,
  onSaveAndUse,
}: {
  isBuiltin: boolean;
  saving: boolean;
  onSave: () => void;
  onSaveAndUse: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" disabled={saving} onClick={onSave}>
        {intl.formatMessage({
          id: isBuiltin ? "settings.themeSkin.editor.saveAsCopy" : "settings.themeSkin.editor.save",
        })}
      </Button>
      <Button type="button" disabled={saving} onClick={onSaveAndUse}>
        {intl.formatMessage({
          id: isBuiltin
            ? "settings.themeSkin.editor.saveAsCopyAndUse"
            : "settings.themeSkin.editor.saveAndUse",
        })}
      </Button>
    </div>
  );
}
