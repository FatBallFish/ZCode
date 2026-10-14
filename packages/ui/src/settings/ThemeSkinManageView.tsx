import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Moon, Pencil, Plus, Sun, Trash2, Upload } from "lucide-react";
import type { ThemeSkinListItem, ThemeSkinRuntime } from "@zcode/shared";
import {
  BUILTIN_THEME_SKINS,
  DEFAULT_THEME_SKIN_ID,
  buildRuntimeFromBuiltin,
  buildRuntimeFromListItem,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import {
  SettingsBreadcrumbReporter,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { ThemeSkinCardPreview } from "@/theme-skins/ThemeSkinPreview.js";

/**
 * 主题皮肤管理二级页（specs/ui/theme-skins.md §1）：内置 + 自定义皮肤网格，
 * 使用/编辑/导出/删除 + 导入 .mikikotheme + 新建。交互骨架对齐宠物管理页。
 */

export interface ThemeSkinEditSource {
  /** 编辑起点：完整 token 快照（内置皮肤直接取 shared 常量）。 */
  runtime: ThemeSkinRuntime;
  origin:
    | { kind: "builtin" }
    | { kind: "new" }
    | { kind: "custom"; id: string; wasActive: boolean };
  /** 已保存主题的库内壁纸绝对路径（一键配色按已存图取色用）。 */
  wallpaperImagePath?: string;
}

interface ThemeSkinCardData {
  runtime: ThemeSkinRuntime;
  builtin: boolean;
  item?: ThemeSkinListItem;
  name: string;
}

export function ThemeSkinManageView({
  onExit,
  onEdit,
}: {
  onExit: () => void;
  onEdit: (source: ThemeSkinEditSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const theme = useZCodeStore((state) => state.theme);
  const themeSkin = useZCodeStore((state) => state.themeSkin);
  const setThemeSkin = useZCodeStore((state) => state.setThemeSkin);
  const [previewMode, setPreviewMode] = useState<"light" | "dark">(() => resolveTheme(theme));
  const [customSkins, setCustomSkins] = useState<ThemeSkinListItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const builtinSkinName = useCallback(
    (id: string) => intl.formatMessage({ id: `settings.themeSkin.builtin.${id}.name` }),
    [intl],
  );

  const loadCustomSkins = useCallback(() => {
    platform
      .themeSkinListInstalled?.()
      .then(setCustomSkins)
      .catch(() => undefined);
  }, [platform]);

  useEffect(() => {
    loadCustomSkins();
  }, [loadCustomSkins]);

  const cards = useMemo<ThemeSkinCardData[]>(() => {
    const builtin: ThemeSkinCardData[] = BUILTIN_THEME_SKINS.map((skin) => ({
      runtime: buildRuntimeFromBuiltin(skin, builtinSkinName(skin.id)),
      builtin: true,
      name: builtinSkinName(skin.id),
    }));
    const custom: ThemeSkinCardData[] = customSkins.map((item) => ({
      runtime: buildRuntimeFromListItem(item),
      builtin: false,
      item,
      name: item.name,
    }));
    return [...builtin, ...custom];
  }, [builtinSkinName, customSkins]);

  const handleUse = useCallback(
    (card: ThemeSkinCardData) => {
      // 默认皮肤 = 显式回落（清除覆盖），其余应用完整运行态。
      setThemeSkin(card.runtime.id === DEFAULT_THEME_SKIN_ID ? null : card.runtime);
    },
    [setThemeSkin],
  );

  const handleExport = useCallback(
    async (card: ThemeSkinCardData) => {
      if (!platform.saveFile) return;
      setBusyId(card.runtime.id);
      try {
        let json: string | undefined;
        if (card.builtin) {
          // 内置皮肤不落盘：renderer 从常量直接组装导出文件（内置壁纸仅 CSS 渐变）。
          const wallpaper = card.runtime.wallpaper;
          json = `${JSON.stringify(
            {
              format: "mikiko-theme-skin",
              formatVersion: 1,
              name: card.name,
              light: card.runtime.light,
              dark: card.runtime.dark,
              ...(wallpaper?.kind === "css" ? { wallpaper } : {}),
            },
            null,
            2,
          )}\n`;
        } else if (card.item) {
          const result = await platform.themeSkinReadExportFile?.(card.item.id);
          if (!result?.json) {
            toast(result?.error ?? intl.formatMessage({ id: "settings.themeSkin.exportFailed" }));
            return;
          }
          json = result.json;
        }
        if (!json) return;
        const safeName = card.name.replace(/[\\/:*?"<>|]/g, "_").trim() || "theme";
        // saveFile 通道要求 ArrayBuffer；slice 保证 byteOffset=0 且长度精确。
        const bytes = new TextEncoder().encode(json);
        const data = bytes.slice().buffer as ArrayBuffer;
        const saveResult = await platform.saveFile({
          data,
          suggestedName: `${safeName}.mikikotheme`,
        });
        if (saveResult.error) {
          toast(saveResult.error);
        } else if (saveResult.success) {
          toast(intl.formatMessage({ id: "settings.themeSkin.exported" }));
        }
      } finally {
        setBusyId(null);
      }
    },
    [intl, platform],
  );

  const handleDelete = useCallback(
    async (card: ThemeSkinCardData) => {
      if (card.builtin || !card.item) return;
      const confirmed = await confirmDialog({
        title: intl.formatMessage({
          id: "settings.themeSkin.deleteConfirmTitle",
        }),
        description: intl.formatMessage(
          { id: "settings.themeSkin.deleteConfirmDescription" },
          { name: card.name },
        ),
        confirmLabel: intl.formatMessage({ id: "settings.themeSkin.delete" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyId(card.runtime.id);
      try {
        // 删除正在使用的皮肤先回落默认，避免残留悬空运行态。
        if (themeSkin?.id === card.item.id) {
          setThemeSkin(null);
        }
        const result = await platform.themeSkinDelete?.(card.item.id);
        if (!result?.ok) {
          toast(result?.error ?? intl.formatMessage({ id: "settings.themeSkin.deleteFailed" }));
          return;
        }
        loadCustomSkins();
      } finally {
        setBusyId(null);
      }
    },
    [confirmDialog, intl, loadCustomSkins, platform, setThemeSkin, themeSkin],
  );

  const handleImport = useCallback(async () => {
    setBusyId("__import__");
    try {
      const result = await platform.themeSkinImportFromFile?.();
      if (!result) return;
      if (!result.ok) {
        if (result.error !== "canceled") {
          toast(
            result.error === "invalid theme file: schema"
              ? intl.formatMessage({
                  id: "settings.themeSkin.importFailedInvalid",
                })
              : result.error,
          );
        }
        return;
      }
      loadCustomSkins();
      toast(intl.formatMessage({ id: "settings.themeSkin.imported" }, { name: result.item.name }));
    } finally {
      setBusyId(null);
    }
  }, [intl, loadCustomSkins, platform]);

  const breadcrumbItems: SettingsBreadcrumbItem[] = [
    {
      label: intl.formatMessage({ id: "settings.themeSkin.manage.pageTitle" }),
    },
  ];

  return (
    <>
      <SettingsBreadcrumbReporter items={breadcrumbItems} onSectionSelect={onExit} />
      <div className="space-y-5" data-testid="theme-skin-manage">
        <section className="space-y-3">
          <SettingsGroupCard>
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.themeSkin.installed.section",
              })}
              description={intl.formatMessage({
                id: "settings.themeSkin.installed.description",
              })}
              control={
                <div className="flex items-center gap-2">
                  {/* 预览模式切换：皮肤卡片按所选明/暗模式渲染。 */}
                  <div className="flex items-center rounded-lg border border-border p-0.5">
                    {(["light", "dark"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-label={intl.formatMessage({
                          id: `settings.themeSkin.preview.${mode}`,
                        })}
                        className={cn(
                          "flex size-6 items-center justify-center rounded-md",
                          previewMode === mode
                            ? "bg-selected text-foreground"
                            : "text-foreground-subtle hover:bg-hover",
                        )}
                        onClick={() => setPreviewMode(mode)}
                      >
                        {mode === "light" ? (
                          <Sun className="size-3.5" aria-hidden="true" />
                        ) : (
                          <Moon className="size-3.5" aria-hidden="true" />
                        )}
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busyId === "__import__"}
                    onClick={() => void handleImport()}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.themeSkin.import" })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      onEdit({
                        runtime: {
                          id: "draft-new",
                          name: intl.formatMessage({
                            id: "settings.themeSkin.newThemeName",
                          }),
                          builtin: false,
                          light: {},
                          dark: {},
                        },
                        origin: { kind: "new" },
                      })
                    }
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.themeSkin.create" })}
                  </Button>
                </div>
              }
              detail={
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {cards.map((card) => {
                    const active = (themeSkin?.id ?? DEFAULT_THEME_SKIN_ID) === card.runtime.id;
                    return (
                      <div
                        key={card.runtime.id}
                        className={cn(
                          "flex flex-col gap-2 rounded-xl border p-3",
                          active ? "border-primary/60" : "border-border",
                        )}
                      >
                        <button
                          type="button"
                          className="w-full cursor-pointer text-left"
                          onClick={() => handleUse(card)}
                        >
                          <ThemeSkinCardPreview skin={card.runtime} mode={previewMode} />
                          <div className="mt-2 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-ui-base text-foreground">
                                {card.name}
                              </span>
                              <span className="shrink-0 rounded-[4px] bg-tag px-1 py-px text-ui-xs text-foreground-subtle">
                                {card.builtin
                                  ? intl.formatMessage({
                                      id: "settings.themeSkin.builtinTag",
                                    })
                                  : intl.formatMessage({
                                      id: "settings.themeSkin.customTag",
                                    })}
                              </span>
                            </div>
                            {card.runtime.wallpaper ? (
                              <div className="truncate text-ui-sm text-foreground-subtle">
                                {intl.formatMessage({
                                  id: "settings.themeSkin.withWallpaper",
                                })}
                              </div>
                            ) : null}
                          </div>
                        </button>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant={active ? "secondary" : "outline"}
                            size="sm"
                            className="flex-1"
                            onClick={() => handleUse(card)}
                          >
                            {active
                              ? intl.formatMessage({
                                  id: "settings.themeSkin.using",
                                })
                              : intl.formatMessage({
                                  id: "settings.themeSkin.use",
                                })}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={intl.formatMessage({
                              id: "settings.themeSkin.edit",
                            })}
                            onClick={() =>
                              onEdit({
                                runtime: card.runtime,
                                origin: card.builtin
                                  ? { kind: "builtin" }
                                  : {
                                      kind: "custom",
                                      id: card.item!.id,
                                      wasActive: active,
                                    },
                                ...(card.item?.wallpaperImagePath
                                  ? { wallpaperImagePath: card.item.wallpaperImagePath }
                                  : {}),
                              })
                            }
                          >
                            <Pencil className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={intl.formatMessage({
                              id: "settings.themeSkin.export",
                            })}
                            disabled={busyId === card.runtime.id}
                            onClick={() => void handleExport(card)}
                          >
                            <Upload className="size-4" aria-hidden="true" />
                          </Button>
                          {!card.builtin ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={intl.formatMessage({
                                id: "settings.themeSkin.delete",
                              })}
                              disabled={busyId === card.runtime.id}
                              onClick={() => void handleDelete(card)}
                            >
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              }
            />
          </SettingsGroupCard>
        </section>
      </div>
    </>
  );
}
