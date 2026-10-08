import { useCallback, useEffect, useMemo, useState } from "react";
import { Cat, Download, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import {
  searchMarketPets,
  type AppSettings,
  type InstalledPetInfo,
  type MarketPetEntry,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SettingsBreadcrumbReporter,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { PetSpritePreview } from "@/settings/PetSpritePreview.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 宠物管理整页子视图（specs/desktop/desktop-pet.md）：已安装列表（使用/更新/卸载）、
 * Codex 只读导入、市场浏览/搜索/安装。从 PetSettingsSection 拆出以控制文件行数。
 */

interface MarketCardState {
  dataUrl?: string;
}

export function PetManageView({ onExit }: { onExit: () => void }) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const [installed, setInstalled] = useState<InstalledPetInfo[]>([]);
  const [pets, setPets] = useState<MarketPetEntry[]>([]);
  const [categories, setCategories] = useState<{ slug: string; label?: Record<string, string> }[]>(
    [],
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [previews, setPreviews] = useState<Map<string, MarketCardState>>(new Map());
  const [busyPetId, setBusyPetId] = useState<string | null>(null);
  const { settings, update } = useSettings();
  const petId = settings?.desktopPetId;

  const filtered = useMemo(() => {
    let result = searchMarketPets(pets, query);
    if (category) result = result.filter((entry) => entry.primary_category === category);
    return result;
  }, [category, pets, query]);
  const filteredKey = useMemo(
    () =>
      `${filtered.length}:${filtered
        .slice(0, 60)
        .map((entry) => entry.slug)
        .join(",")}`,
    [filtered],
  );

  const loadInstalled = useCallback(() => {
    platform
      .petListInstalled?.()
      .then(setInstalled)
      .catch(() => undefined);
  }, [platform]);

  const loadCatalog = useCallback(
    (refresh: boolean) => {
      setLoadingCatalog(true);
      setCatalogError(null);
      platform
        .petMarketGetCatalog?.({ refresh })
        .then((result) => {
          setPets(result.pets);
          setCategories(result.categories);
        })
        .catch((error) => setCatalogError(String(error)))
        .finally(() => setLoadingCatalog(false));
    },
    [platform],
  );

  useEffect(() => {
    loadInstalled();
    loadCatalog(false);
  }, [loadCatalog, loadInstalled]);

  // 预览图按可见卡片区渐进加载（一次性批量，305 只上限可承受；失败静默占位）。
  useEffect(() => {
    const pending = filtered.slice(0, 60).map((entry) => entry.slug);
    let cancelled = false;
    void Promise.all(
      pending.map(async (slug) => {
        if (previews.has(slug)) return;
        const result = await platform.petMarketPreview?.(slug).catch(() => undefined);
        if (!cancelled && result?.dataUrl) {
          setPreviews((current) => new Map(current).set(slug, { dataUrl: result.dataUrl }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只随过滤结果集变化加载。
  }, [filteredKey]);

  const handleInstall = useCallback(
    async (slug: string, force: boolean) => {
      setBusyPetId(slug);
      try {
        const result = await platform.petMarketInstall?.(slug, force);
        if (!result?.ok) {
          toast(result?.error ?? intl.formatMessage({ id: "settings.pet.installFailed" }));
          return;
        }
        toast(intl.formatMessage({ id: "settings.pet.installed.ok" }));
        loadInstalled();
      } finally {
        setBusyPetId(null);
      }
    },
    [intl, loadInstalled, platform],
  );

  const handleUninstall = useCallback(
    async (slug: string) => {
      setBusyPetId(slug);
      try {
        const result = await platform.petMarketUninstall?.(slug);
        if (!result?.ok) {
          toast(result?.error ?? intl.formatMessage({ id: "settings.pet.uninstallFailed" }));
          return;
        }
        if (petId === slug) {
          await update({
            desktopPetEnabled: false,
            desktopPetId: undefined,
          } satisfies Partial<AppSettings>);
        }
        loadInstalled();
      } finally {
        setBusyPetId(null);
      }
    },
    [intl, loadInstalled, petId, platform, update],
  );

  const handleImportCodex = useCallback(async () => {
    setBusyPetId("__codex__");
    try {
      const result = await platform.petImportFromCodex?.();
      if (!result) return;
      toast(
        intl.formatMessage(
          { id: "settings.pet.importCodex.done" },
          { count: result.imported.length },
        ),
      );
      loadInstalled();
    } finally {
      setBusyPetId(null);
    }
  }, [intl, loadInstalled, platform]);

  const breadcrumbItems: SettingsBreadcrumbItem[] = [
    { label: intl.formatMessage({ id: "settings.pet.manage.pageTitle" }) },
  ];

  return (
    <>
      <SettingsBreadcrumbReporter items={breadcrumbItems} onSectionSelect={onExit} />
      <div className="space-y-5" data-testid="pet-manage">
        <section className="space-y-3">
          <SettingsGroupCard>
            <SettingsRow
              label={intl.formatMessage({ id: "settings.pet.installed.section" })}
              description={
                installed.length === 0
                  ? intl.formatMessage({ id: "settings.pet.installed.empty" })
                  : undefined
              }
              control={
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyPetId === "__codex__"}
                  onClick={() => void handleImportCodex()}
                >
                  <Download className="size-4" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.pet.importCodex" })}
                </Button>
              }
              detail={
                installed.length > 0 ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                    {installed.map((pet) => (
                      <div
                        key={pet.id}
                        className={`flex flex-col gap-2 rounded-xl border p-3 ${
                          pet.id === petId ? "border-primary/60" : "border-border"
                        }`}
                      >
                        <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-surface">
                          {/* 铺满预览盒；192×208 竖向帧在横向盒内由组件等比居中绘制，避免拉伸。 */}
                          <PetSpritePreview petId={pet.id} className="h-full w-full" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-ui-base text-foreground">
                            {pet.displayName}
                          </div>
                          <div className="truncate text-ui-base text-foreground-subtle">
                            v{pet.spriteVersionNumber} ·{" "}
                            {pet.installedFrom === "codex-import"
                              ? "Codex"
                              : pet.installedFrom === "builtin"
                                ? intl.formatMessage({ id: "settings.pet.fromBuiltin" })
                                : intl.formatMessage({ id: "settings.pet.fromMarket" })}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {pet.updatable ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              disabled={busyPetId === pet.id}
                              onClick={() => void handleInstall(pet.id, true)}
                            >
                              <RotateCcw className="size-4" aria-hidden="true" />
                              {intl.formatMessage({ id: "settings.pet.update" })}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant={pet.id === petId ? "secondary" : "outline"}
                            size="sm"
                            className="flex-1"
                            onClick={() =>
                              void update({
                                desktopPetId: pet.id,
                                desktopPetEnabled: true,
                              } satisfies Partial<AppSettings>)
                            }
                          >
                            {pet.id === petId
                              ? intl.formatMessage({ id: "settings.pet.using" })
                              : intl.formatMessage({ id: "settings.pet.use" })}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={intl.formatMessage({ id: "settings.pet.uninstall" })}
                            disabled={busyPetId === pet.id}
                            onClick={() => void handleUninstall(pet.id)}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : undefined
              }
            />
          </SettingsGroupCard>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "settings.pet.market.section" })}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loadingCatalog}
              onClick={() => loadCatalog(true)}
            >
              <RefreshCw
                className={`size-4 ${loadingCatalog ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {intl.formatMessage({ id: "settings.pet.market.refresh" })}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              value={query}
              placeholder={intl.formatMessage({ id: "settings.pet.market.searchPlaceholder" })}
              className="max-w-72"
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              value={category}
              className="h-10 rounded-md border border-border bg-surface px-3 text-ui-base text-foreground"
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">
                {intl.formatMessage({ id: "settings.pet.market.allCategories" })}
              </option>
              {categories.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.label?.[locale] ?? item.label?.en ?? item.slug}
                </option>
              ))}
            </select>
          </div>
          {catalogError ? (
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.pet.market.loadFailed" })}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {filtered.slice(0, 120).map((entry) => {
              const isInstalled = installed.some((pet) => pet.id === entry.slug);
              return (
                <div
                  key={entry.slug}
                  className="flex flex-col gap-2 rounded-xl border border-border p-3"
                >
                  <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-surface">
                    {previews.get(entry.slug)?.dataUrl ? (
                      <img
                        src={previews.get(entry.slug)?.dataUrl}
                        alt={entry.name}
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <Cat className="size-10 text-foreground-subtle/40" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-ui-base text-foreground">
                      {entry.localized_names?.zh ?? entry.name}
                    </div>
                    <div className="truncate text-ui-base text-foreground-subtle">
                      {entry.author ?? ""} · v{entry.spriteVersionNumber ?? 1}
                    </div>
                  </div>
                  {isInstalled ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyPetId === entry.slug}
                      onClick={() => void handleInstall(entry.slug, true)}
                    >
                      {intl.formatMessage({ id: "settings.pet.update" })}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busyPetId === entry.slug}
                      onClick={() => void handleInstall(entry.slug, false)}
                    >
                      {intl.formatMessage({ id: "settings.pet.market.install" })}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {filtered.length > 120 ? (
            <div className="text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.pet.market.more" },
                { count: filtered.length - 120 },
              )}
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
