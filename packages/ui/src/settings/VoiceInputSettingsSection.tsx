/**
 * 语音输入设置（specs/desktop/voice-input.md §3.1/§3.4/§3.5）：
 * 识别模型卡（特点/磁盘/内存/下载状态）、输入设备与麦克风权限、语义整理开关与模型选择
 * （复用 ModelConfigSelect）、快捷键展示与跳转、引擎占用与「立即释放」。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines } from "lucide-react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  DEFAULT_VOICE_MODEL_ID,
  ZCODE_AGENT_PROVIDER,
  type AppSettings,
  type VoiceStateSnapshot,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { buildChatGPTAccountLabels, useChatGPTAccounts } from "@/hooks/useChatGPTAccounts.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { VoiceDevicePermissionCard } from "@/settings/VoiceDevicePermissionCard.js";
import { VoiceModelCardList } from "@/settings/VoiceModelCardList.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

export function VoiceInputSettingsSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const shortcutLabel = useShortcutCommandLabel("voiceInput");
  const [snapshot, setSnapshot] = useState<VoiceStateSnapshot | null>(null);

  // 整理模型候选取本地工作区的模型视图（与自动化设置同源）：含账号系/中转站/自定义
  // 供应商。base host 视图只有账号系，中转站模型全部缺席（spec §3.3）。本地 workspace
  // 共享同一 Host，任取一个即可；设置页打开时活动 tab 可能不是工作区（实测踩坑），
  // 回退到第一个本地工作区 tab，避免下拉被禁用、迁移补档位不触发。
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const activeWorkspace = useMemo(() => {
    const asLocal = (tab: (typeof tabs)[number] | undefined) =>
      tab && isWorkspaceTab(tab) && !tab.remoteSessionId ? tab : null;
    const active = asLocal(activeTabId ? tabs.find((item) => item.id === activeTabId) : undefined);
    const picked = active ?? tabs.map(asLocal).find(Boolean) ?? null;
    return picked
      ? { workspacePath: picked.workspacePath, workspaceIdentity: picked.workspaceIdentity ?? null }
      : null;
  }, [activeTabId, tabs]);

  const cleanupSelection = settings?.voiceCleanupSelection;
  const modelSelectionRead = useModelSelectionView(
    activeWorkspace?.workspacePath ?? null,
    undefined,
    activeWorkspace?.workspaceIdentity ?? null,
    undefined,
    {
      selection: cleanupSelection
        ? {
            providerId: cleanupSelection.providerId,
            modelId: cleanupSelection.modelId,
            ...(cleanupSelection.reasoningLevel
              ? { options: { reasoningLevel: cleanupSelection.reasoningLevel } }
              : {}),
          }
        : null,
    },
  );

  const available = isDesktop && typeof platform.voiceGetState === "function";
  const selectedModelId = settings?.voiceInputModelId ?? DEFAULT_VOICE_MODEL_ID;

  const refreshSnapshot = useCallback(() => {
    if (!available) return;
    platform
      .voiceGetState?.()
      .then(setSnapshot)
      .catch((error) => logger.warn("[voice-settings] get state failed", { error: String(error) }));
  }, [available, platform]);

  useEffect(() => {
    if (!available) return;
    refreshSnapshot();
    const dispose = platform.onVoiceStateChanged?.((next) => setSnapshot(next));
    return () => dispose?.();
  }, [available, platform, refreshSnapshot]);

  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const { accounts: chatGPTAccounts } = useChatGPTAccounts();
  const chatGPTAccountLabels = useMemo(
    () => buildChatGPTAccountLabels(chatGPTAccounts),
    [chatGPTAccounts],
  );
  const cleanupSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      chatGPTAccountLabels,
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [chatGPTAccountLabels, intl, modelSelectionView]);

  const cleanupEnabled = settings?.voiceCleanupEnabled === true;
  const normalizedCleanupValue = cleanupSelection
    ? encodeCustomModelValue(cleanupSelection.providerId, cleanupSelection.modelId)
    : "";
  // 触发器显示选中模型名：优先取分组里的展示名（带中转站徽标的完整列表项）。
  const selectedCleanupItem = cleanupSelection
    ? cleanupSelectGroups
        .flatMap((group) => group.items)
        .find((item) => item.value === normalizedCleanupValue)
    : undefined;

  const handleCleanupModelChange = useCallback(
    (value: string) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.modelName) return;
      // 2026-10-14：语音整理选模型时补最低档（文案润色不需要深度思考），
      // 此前补最高档导致 GLM-5.3 在高思考档下既慢又容易耗尽输出预算。
      const model = modelSelectionView?.providers
        ?.find((p) => p.providerId === decoded.providerId)
        ?.models?.find((m) => m.modelId === decoded.modelName);
      const lowestLevel = model?.config?.optionSpecs?.reasoningLevel?.values?.[0];
      void update({
        voiceCleanupSelection: {
          providerId: decoded.providerId,
          modelId: decoded.modelName,
          ...(lowestLevel ? { reasoningLevel: lowestLevel } : {}),
        },
      } satisfies Partial<AppSettings>);
    },
    [modelSelectionView, update],
  );

  const handleDownload = useCallback(
    async (modelId: string) => {
      try {
        const result = await platform.voiceDownloadModel?.(modelId);
        if (result && !result.ok) {
          toast(intl.formatMessage({ id: "settings.voiceInput.download.failed" }));
        }
      } catch (error) {
        logger.warn("[voice-settings] download failed", { error: String(error) });
        toast(intl.formatMessage({ id: "settings.voiceInput.download.failed" }));
      }
    },
    [intl, platform],
  );

  const handleDelete = useCallback(
    async (modelId: string) => {
      try {
        const result = await platform.voiceDeleteModel?.(modelId);
        if (result && !result.ok) {
          toast(result.error ?? intl.formatMessage({ id: "settings.voiceInput.delete.failed" }));
          return;
        }
        // 删除的是当前选中模型时回落默认，避免「选中但未安装」的悬空选择。
        if (selectedModelId === modelId) {
          await update({
            voiceInputModelId: DEFAULT_VOICE_MODEL_ID,
          } satisfies Partial<AppSettings>);
        }
        refreshSnapshot();
      } catch (error) {
        logger.warn("[voice-settings] delete failed", { error: String(error) });
      }
    },
    [intl, platform, refreshSnapshot, selectedModelId, update],
  );

  const handleUnloadEngine = useCallback(async () => {
    const result = await platform.voiceUnloadEngine?.().catch(() => null);
    if (result && !result.ok) {
      toast(result.error ?? intl.formatMessage({ id: "settings.voiceInput.engine.unloadFailed" }));
      return;
    }
    refreshSnapshot();
  }, [intl, platform, refreshSnapshot]);

  if (!available) {
    return (
      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.voiceInput.title" })}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voiceInput.title" })}
            description={intl.formatMessage({ id: "settings.voiceInput.desktopOnly" })}
            control={<span aria-hidden="true" />}
          />
        </SettingsGroupCard>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.voiceInput.title" })}
      </div>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.recognition.title" })}
          description={intl.formatMessage({ id: "settings.voiceInput.recognition.description" })}
          control={<span aria-hidden="true" />}
        />
        <VoiceModelCardList
          snapshot={snapshot}
          selectedModelId={selectedModelId}
          onSelect={(modelId) =>
            void update({ voiceInputModelId: modelId } satisfies Partial<AppSettings>)
          }
          onDownload={(modelId) => void handleDownload(modelId)}
          onDelete={(modelId) => void handleDelete(modelId)}
        />
      </SettingsGroupCard>

      <VoiceDevicePermissionCard />

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.cleanup.title" })}
          description={intl.formatMessage({ id: "settings.voiceInput.cleanup.description" })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.voiceInput.cleanup.title" })}
              checked={cleanupEnabled}
              onCheckedChange={(checked) =>
                void update({ voiceCleanupEnabled: checked } satisfies Partial<AppSettings>)
              }
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.cleanup.model" })}
          description={intl.formatMessage({ id: "settings.voiceInput.cleanup.modelDescription" })}
          control={
            <ModelConfigSelect
              modelGroups={cleanupSelectGroups}
              normalizedValue={normalizedCleanupValue}
              triggerLabel={
                cleanupSelection
                  ? (selectedCleanupItem?.name ??
                    `${cleanupSelection.providerId}/${cleanupSelection.modelId}`)
                  : intl.formatMessage({ id: "settings.voiceInput.cleanup.modelPlaceholder" })
              }
              // 默认值 "hidden @xl/composer:inline-flex" 是聊天输入框的响应式容器类，
              // 设置页没有该容器会导致已选模型名永远隐藏（真机反馈）。
              labelVisibilityClassName="inline-flex"
              // 不能设 showProviderLevel={false}：那会只渲染第一个分组（智谱账号组）的
              // 扁平列表，中转站/自定义供应商的分组全部不出现（真机反馈）。默认按
              // 供应商子菜单展示全量候选。
              showManageModelsAction={false}
              lockReasonMessage=""
              isItemLocked={MODEL_ITEM_NEVER_LOCKED}
              onValueChange={handleCleanupModelChange}
              disabled={!cleanupEnabled || cleanupSelectGroups.length === 0}
              tooltipTitle={intl.formatMessage({ id: "settings.voiceInput.cleanup.model" })}
              contentSide="top"
              contentAlign="end"
              triggerClassName="w-fit max-w-72 min-w-0 justify-between px-2"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.shortcut.title" })}
          description={intl.formatMessage({ id: "settings.voiceInput.shortcut.description" })}
          control={
            <div className="flex items-center gap-2">
              {shortcutLabel ? (
                <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-ui-xs text-fg-subtle">
                  {shortcutLabel}
                </kbd>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setPendingSettingsSection("shortcuts")}
              >
                {intl.formatMessage({ id: "settings.voiceInput.shortcut.manage" })}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.engine.title" })}
          description={
            snapshot?.loadedModelId
              ? intl.formatMessage(
                  { id: "settings.voiceInput.engine.loaded" },
                  { model: snapshot.loadedModelId },
                )
              : intl.formatMessage({ id: "settings.voiceInput.engine.idle" })
          }
          control={
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!snapshot?.loadedModelId}
              onClick={() => void handleUnloadEngine()}
            >
              <AudioLines className="size-4" aria-hidden />
              {intl.formatMessage({ id: "settings.voiceInput.engine.unload" })}
            </Button>
          }
        />
      </SettingsGroupCard>
    </section>
  );
}
