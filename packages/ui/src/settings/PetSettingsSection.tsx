import { useCallback, useEffect, useState } from "react";
import { Cat } from "lucide-react";
import type { AppSettings, InstalledPetInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { PetSpritePreview } from "@/settings/PetSpritePreview.js";
import { PetManageView } from "@/settings/PetMarketManageView.js";

/**
 * 宠物设置（specs/desktop/desktop-pet.md）：摘要页（开关/当前宠物）+ 整页管理子视图
 * （已安装列表、Codex 导入、市场浏览/搜索/安装/更新）。面包屑模式与钩子/外部浏览器一致。
 * 市场网络全部经 main 代理（platform.petMarket*），renderer 不直连远端。
 */

type PetManageViewMode = "summary" | "manage";

export function PetSettingsSection({ isDesktop }: { isDesktop: boolean }) {
  const [view, setView] = useState<PetManageViewMode>("summary");
  if (view === "manage" && isDesktop) {
    return <PetManageView onExit={() => setView("summary")} />;
  }
  return <PetSummaryView isDesktop={isDesktop} onManage={() => setView("manage")} />;
}

function PetSummaryView({ isDesktop, onManage }: { isDesktop: boolean; onManage: () => void }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const [installed, setInstalled] = useState<InstalledPetInfo[]>([]);

  const enabled = settings?.desktopPetEnabled === true;
  const petId = settings?.desktopPetId ?? installed[0]?.id;
  // 未显式选择时按第一只已安装（内置预置后必有）展示为默认；开关随安装状态可用。
  const current = installed.find((pet) => pet.id === petId);
  const available = isDesktop && typeof platform.petListInstalled === "function";

  useEffect(() => {
    if (!available) return;
    platform
      .petListInstalled?.()
      .then(setInstalled)
      .catch((error) =>
        logger.warn("[pet-settings] list installed failed", { error: String(error) }),
      );
  }, [available, platform]);

  const handleEnabledChange = useCallback(
    async (next: boolean) => {
      if (next && !settings?.desktopPetId && installed[0]) {
        await update({
          desktopPetEnabled: true,
          desktopPetId: installed[0].id,
        } satisfies Partial<AppSettings>);
        return;
      }
      await update({ desktopPetEnabled: next } satisfies Partial<AppSettings>);
    },
    [installed, settings, update],
  );

  if (!available) {
    return (
      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.pet.title" })}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.pet.title" })}
            description={intl.formatMessage({ id: "settings.pet.desktopOnly" })}
            control={<span aria-hidden="true" />}
          />
        </SettingsGroupCard>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.pet.title" })}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.pet.enabled.title" })}
          description={intl.formatMessage({ id: "settings.pet.enabled.description" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.pet.enabled.title" })}
              checked={enabled && Boolean(petId)}
              disabled={installed.length === 0}
              onCheckedChange={(checked) => void handleEnabledChange(checked)}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.pet.current.title" })}
          description={
            current
              ? `${current.displayName} · v${current.spriteVersionNumber}${
                  settings?.desktopPetId
                    ? ""
                    : ` · ${intl.formatMessage({ id: "settings.pet.current.default" })}`
                }`
              : intl.formatMessage({ id: "settings.pet.current.none" })
          }
          detail={
            current ? (
              // 当前启用宠物单独一行：动图预览 + 名称，与已安装卡片视觉一致。
              <div className="flex items-center gap-3">
                <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg bg-surface">
                  {/* 等比绘制由组件内部保证；画布铺满方形盒，避免 w-auto 横向溢出被裁剪。 */}
                  <PetSpritePreview petId={current.id} className="h-full w-full" />
                </div>
                <div className="min-w-0">
                  <div className="text-ui-base text-foreground">{current.displayName}</div>
                  <div className="truncate text-ui-base text-foreground-subtle">{current.id}</div>
                </div>
              </div>
            ) : undefined
          }
          control={
            <Button type="button" variant="outline" onClick={onManage}>
              <Cat className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.pet.manage" })}
            </Button>
          }
        />
      </SettingsGroupCard>
    </section>
  );
}
