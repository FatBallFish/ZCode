import { useCallback, useState } from "react";
import { AppearanceSectionContent } from "@/settingsCodePreview.js";
import { ThemeSkinManageView, type ThemeSkinEditSource } from "@/settings/ThemeSkinManageView.js";
import { ThemeSkinEditView } from "@/settings/ThemeSkinEditView.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/**
 * 外观分区容器（specs/ui/theme-skins.md §1）：持有 summary | skins | edit 三态视图状态机。
 * 交互模式与宠物分区一致（PetSettingsSection）：二级页整页替换外观内容，
 * 经 SettingsBreadcrumbReporter 上报面包屑，返回时回到外观 summary。
 */
export function AppearanceSettingsSection(
  props: React.ComponentProps<typeof AppearanceSectionContent>,
) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const themeSkin = useZCodeStore((state) => state.themeSkin);
  const [view, setView] = useState<"appearance" | "skins" | "edit">("appearance");
  const [editSource, setEditSource] = useState<ThemeSkinEditSource | null>(null);

  // 桌面专属能力（与宠物一致）：platform 未暴露皮肤通道时隐藏入口。
  const themeSkinAvailable = platform?.themeSkinListInstalled !== undefined;
  const resolveSkinName = useCallback(
    () =>
      themeSkin
        ? themeSkin.builtin
          ? intl.formatMessage({
              id: `settings.themeSkin.builtin.${themeSkin.id}.name`,
            })
          : themeSkin.name
        : intl.formatMessage({
            id: "settings.themeSkin.builtin.mikiko-default.name",
          }),
    [intl, themeSkin],
  );

  if (view === "skins") {
    return (
      <ThemeSkinManageView
        onExit={() => setView("appearance")}
        onEdit={(source) => {
          setEditSource(source);
          setView("edit");
        }}
      />
    );
  }

  if (view === "edit" && editSource) {
    return <ThemeSkinEditView source={editSource} onExit={() => setView("skins")} />;
  }

  return (
    <AppearanceSectionContent
      {...props}
      themeSkinAvailable={themeSkinAvailable}
      themeSkinName={resolveSkinName()}
      onOpenThemeSkins={() => setView("skins")}
    />
  );
}
