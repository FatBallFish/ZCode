import { useCallback, useMemo, useState } from "react";
import { Moon, Sun } from "lucide-react";
import type { ThemeSkinRuntime, ThemeSkinSavePayload, ThemeSkinTokenMap } from "@zcode/shared";
import {
  DEFAULT_THEME_SKIN_WALLPAPER,
  buildRuntimeFromListItem,
  clampThemeSkinWallpaperCommon,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import {
  SettingsBreadcrumbReporter,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { ThemeSkinNewSessionPreview } from "@/theme-skins/ThemeSkinPreview.js";
import type { ThemeSkinEditSource } from "@/settings/ThemeSkinManageView.js";
import {
  type ColorKnobs,
  type WallpaperDraft,
  ColorField,
  applyKnobs,
  readKnobs,
  ThemeSkinWallpaperSettingsCard,
} from "@/settings/ThemeSkinEditParts.js";

/**
 * 主题皮肤编辑器（specs/ui/theme-skins.md §1）：对已加载皮肤的微调。
 * 旋钮：名称 + 每模式（主题色 accent / 主色 primary / 文本色 foreground）+ 壁纸（选图/取景/模糊/压暗）。
 * 主预览 = 新建会话页 mock，单一模式开关同时驱动「编辑目标模式」与「预览模式」。
 * 内置皮肤编辑保存时由服务端生成副本（id 缺省 = 新建），原内置数据不可变。
 */

export function ThemeSkinEditView({
  source,
  onExit,
}: {
  source: ThemeSkinEditSource;
  onExit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const theme = useZCodeStore((state) => state.theme);
  const setThemeSkin = useZCodeStore((state) => state.setThemeSkin);
  const [mode, setMode] = useState<"light" | "dark">(() => resolveTheme(theme));
  const [name, setName] = useState(() =>
    source.origin.kind === "builtin"
      ? `${source.runtime.name} ${intl.formatMessage({ id: "settings.themeSkin.copySuffix" })}`
      : source.runtime.name,
  );
  const [light, setLight] = useState<ThemeSkinTokenMap>(() => ({
    ...source.runtime.light,
  }));
  const [dark, setDark] = useState<ThemeSkinTokenMap>(() => ({
    ...source.runtime.dark,
  }));
  const [wallpaper, setWallpaper] = useState<WallpaperDraft>(() => {
    const wp = source.runtime.wallpaper;
    if (wp?.kind === "css") return { mode: "css", css: wp.css };
    if (wp?.kind === "image")
      return {
        mode: "image",
        previewUrl: wp.url,
        stagedPath: null,
        fromExisting: true,
      };
    return { mode: "none" };
  });
  const wallpaperCommon = useMemo(
    () => clampThemeSkinWallpaperCommon(source.runtime.wallpaper ?? DEFAULT_THEME_SKIN_WALLPAPER),
    [source.runtime.wallpaper],
  );
  const [fit, setFit] = useState(wallpaperCommon.fit);
  const [blurPx, setBlurPx] = useState(wallpaperCommon.blurPx);
  const [dimLight, setDimLight] = useState(wallpaperCommon.dimPercentLight);
  const [dimDark, setDimDark] = useState(wallpaperCommon.dimPercentDark);
  const [saving, setSaving] = useState(false);

  const knobs = readKnobs(mode === "light" ? light : dark, mode);
  const setKnobValue = useCallback(
    (key: keyof ColorKnobs, value: string) => {
      if (!/^#[\da-fA-F]{6}$/.test(value)) return;
      const next: ColorKnobs = { ...knobs, [key]: value };
      if (mode === "light") setLight((map) => applyKnobs(map, next));
      else setDark((map) => applyKnobs(map, next));
    },
    [knobs, mode],
  );

  const draftRuntime: ThemeSkinRuntime = useMemo(() => {
    const wp =
      wallpaper.mode === "css"
        ? {
            kind: "css" as const,
            css: wallpaper.css,
            fit,
            blurPx,
            dimPercentLight: dimLight,
            dimPercentDark: dimDark,
          }
        : wallpaper.mode === "image"
          ? {
              kind: "image" as const,
              url: wallpaper.previewUrl,
              fit,
              blurPx,
              dimPercentLight: dimLight,
              dimPercentDark: dimDark,
            }
          : undefined;
    return {
      id: source.runtime.id,
      name: name.trim() || source.runtime.name,
      builtin: false,
      light,
      dark,
      ...(wp ? { wallpaper: wp } : {}),
    };
  }, [dark, dimDark, dimLight, fit, blurPx, light, name, source.runtime, wallpaper]);

  const handlePickWallpaper = useCallback(async () => {
    const result = await platform.themeSkinStageWallpaperImage?.();
    if (!result || result.canceled || result.error || !result.path) {
      if (result?.error) toast(result.error);
      return;
    }
    setWallpaper({
      mode: "image",
      previewUrl: `themepack://local/asset?path=${encodeURIComponent(result.path)}`,
      stagedPath: result.path,
      fromExisting: false,
    });
  }, [platform]);

  const handleSave = useCallback(
    async (applyAfterSave: boolean) => {
      if (name.trim().length === 0) {
        toast(intl.formatMessage({ id: "settings.themeSkin.editor.nameRequired" }));
        return;
      }
      setSaving(true);
      try {
        const common = {
          fit,
          blurPx,
          dimPercentLight: dimLight,
          dimPercentDark: dimDark,
        };
        let wallpaperSave: ThemeSkinSavePayload["wallpaper"];
        if (wallpaper.mode === "css") {
          wallpaperSave = { mode: "css", css: wallpaper.css, ...common };
        } else if (wallpaper.mode === "image" && wallpaper.stagedPath) {
          wallpaperSave = {
            mode: "image",
            stagedPath: wallpaper.stagedPath,
            ...common,
          };
        } else if (wallpaper.mode === "image") {
          wallpaperSave = { mode: "keep-image", ...common };
        } else {
          wallpaperSave = { mode: "none", ...common };
        }
        const result = await platform.themeSkinSaveCustom?.({
          ...(source.origin.kind === "custom" ? { id: source.origin.id } : {}),
          name: name.trim(),
          light,
          dark,
          wallpaper: wallpaperSave,
        });
        if (!result?.ok) {
          toast(
            result?.error ??
              intl.formatMessage({
                id: "settings.themeSkin.editor.saveFailed",
              }),
          );
          return;
        }
        if (applyAfterSave || (source.origin.kind === "custom" && source.origin.wasActive)) {
          setThemeSkin(buildRuntimeFromListItem(result.item));
        }
        toast(
          intl.formatMessage({ id: "settings.themeSkin.editor.saved" }, { name: result.item.name }),
        );
        onExit();
      } finally {
        setSaving(false);
      }
    },
    [
      blurPx,
      dark,
      dimDark,
      dimLight,
      fit,
      intl,
      light,
      name,
      onExit,
      platform,
      setThemeSkin,
      source.origin,
      wallpaper,
    ],
  );

  const breadcrumbItems: SettingsBreadcrumbItem[] = [
    {
      label: intl.formatMessage({ id: "settings.themeSkin.editor.pageTitle" }),
    },
  ];

  const isBuiltin = source.origin.kind === "builtin";

  return (
    <>
      <SettingsBreadcrumbReporter items={breadcrumbItems} onSectionSelect={onExit} />
      <div className="space-y-5" data-testid="theme-skin-edit">
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-5">
            <SettingsGroupCard>
              <SettingsRow
                label={intl.formatMessage({
                  id: "settings.themeSkin.editor.name",
                })}
                control={
                  <Input
                    value={name}
                    aria-label={intl.formatMessage({
                      id: "settings.themeSkin.editor.name",
                    })}
                    className="w-[220px]"
                    maxLength={60}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                }
              />
            </SettingsGroupCard>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-ui-base font-semibold text-foreground">
                  {intl.formatMessage({
                    id: "settings.themeSkin.editor.colorsTitle",
                  })}
                </h3>
                {/* 单一模式开关同时决定「编辑哪个模式」与「预览哪个模式」。 */}
                <div className="flex items-center rounded-lg border border-border p-0.5">
                  {(["light", "dark"] as const).map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-label={intl.formatMessage({
                        id: `settings.themeSkin.preview.${candidate}`,
                      })}
                      className={cn(
                        "flex h-6 items-center gap-1 rounded-md px-2 text-ui-sm",
                        mode === candidate
                          ? "bg-selected text-foreground"
                          : "text-foreground-subtle hover:bg-hover",
                      )}
                      onClick={() => setMode(candidate)}
                    >
                      {candidate === "light" ? (
                        <Sun className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Moon className="size-3.5" aria-hidden="true" />
                      )}
                      {intl.formatMessage({
                        id: `settings.themeSkin.preview.${candidate}`,
                      })}
                    </button>
                  ))}
                </div>
              </div>
              <SettingsGroupCard>
                <ColorField
                  label={intl.formatMessage({
                    id: "settings.themeSkin.editor.accent",
                  })}
                  value={knobs.accent}
                  onChange={(value) => setKnobValue("accent", value)}
                />
                <ColorField
                  label={intl.formatMessage({
                    id: "settings.themeSkin.editor.primary",
                  })}
                  value={knobs.primary}
                  onChange={(value) => setKnobValue("primary", value)}
                />
                <ColorField
                  label={intl.formatMessage({
                    id: "settings.themeSkin.editor.foreground",
                  })}
                  value={knobs.foreground}
                  onChange={(value) => setKnobValue("foreground", value)}
                />
              </SettingsGroupCard>
            </section>

            <ThemeSkinWallpaperSettingsCard
              wallpaper={wallpaper}
              onWallpaperChange={setWallpaper}
              fit={fit}
              onFitChange={setFit}
              blurPx={blurPx}
              onBlurChange={setBlurPx}
              dimLight={dimLight}
              onDimLightChange={setDimLight}
              dimDark={dimDark}
              onDimDarkChange={setDimDark}
              onPickWallpaper={() => void handlePickWallpaper()}
            />
          </div>

          {/* 主预览：新建会话页（当前模式） */}
          <div className="space-y-2 xl:sticky xl:top-2">
            <div className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.themeSkin.editor.previewTitle",
              })}
            </div>
            <ThemeSkinNewSessionPreview
              skin={draftRuntime}
              mode={mode}
              className="aspect-[4/3]"
              greeting={intl.formatMessage({
                id: "settings.themeSkin.editor.previewGreeting",
              })}
              placeholder={intl.formatMessage({
                id: "settings.themeSkin.editor.previewPlaceholder",
              })}
              suggestions={[
                intl.formatMessage({
                  id: "settings.themeSkin.editor.previewSuggestion1",
                }),
                intl.formatMessage({
                  id: "settings.themeSkin.editor.previewSuggestion2",
                }),
              ]}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => void handleSave(false)}
          >
            {intl.formatMessage({
              id: isBuiltin
                ? "settings.themeSkin.editor.saveAsCopy"
                : "settings.themeSkin.editor.save",
            })}
          </Button>
          <Button type="button" disabled={saving} onClick={() => void handleSave(true)}>
            {intl.formatMessage({
              id: isBuiltin
                ? "settings.themeSkin.editor.saveAsCopyAndUse"
                : "settings.themeSkin.editor.saveAndUse",
            })}
          </Button>
        </div>
      </div>
    </>
  );
}
