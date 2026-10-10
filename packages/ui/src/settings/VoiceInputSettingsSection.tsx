/**
 * 语音输入设置（specs/desktop/voice-input.md §3.1）：
 * 识别模型卡（特点/磁盘/内存/下载状态）、语义整理开关与模型选择（复用 ModelConfigSelect）、
 * 快捷键展示与跳转、引擎占用与「立即释放」。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  CheckCircle2Icon,
  CircleIcon,
  DownloadIcon,
  LoaderIcon,
  Trash2Icon,
} from "lucide-react";
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODEL_MANIFESTS,
  ZCODE_AGENT_PROVIDER,
  type AppSettings,
  type VoiceStateSnapshot,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}

export function VoiceInputSettingsSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const shortcutLabel = useShortcutCommandLabel("voiceInput");
  const [snapshot, setSnapshot] = useState<VoiceStateSnapshot | null>(null);

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
  const cleanupSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);

  const cleanupSelection = settings?.voiceCleanupSelection;
  const cleanupEnabled = settings?.voiceCleanupEnabled === true;
  const normalizedCleanupValue = cleanupSelection
    ? encodeCustomModelValue(cleanupSelection.providerId, cleanupSelection.modelId)
    : "";

  const handleCleanupModelChange = useCallback(
    (value: string) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.modelName) return;
      void update({
        voiceCleanupSelection: { providerId: decoded.providerId, modelId: decoded.modelName },
      } satisfies Partial<AppSettings>);
    },
    [update],
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
        refreshSnapshot();
      } catch (error) {
        logger.warn("[voice-settings] delete failed", { error: String(error) });
      }
    },
    [intl, platform, refreshSnapshot],
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
        {snapshot?.supported === false ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voiceInput.unsupported.title" })}
            description={
              snapshot.unsupportedReason ??
              intl.formatMessage({ id: "settings.voiceInput.unsupported.description" })
            }
            control={<span aria-hidden="true" />}
          />
        ) : null}
        <div className="divide-y divide-border-subtle">
          {VOICE_MODEL_MANIFESTS.map((manifest) => {
            const install = snapshot?.models.find(
              (entry) => entry.modelId === manifest.id,
            )?.install;
            const status = install?.status ?? "not-installed";
            const downloading = install?.status === "downloading" ? install : null;
            const isSelected = selectedModelId === manifest.id;
            return (
              <div
                key={manifest.id}
                data-testid={`voice-model-card-${manifest.id}`}
                data-install-state={status}
                className="flex flex-col gap-2 px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={intl.formatMessage({ id: "settings.voiceInput.model.select" })}
                    disabled={status !== "installed"}
                    onClick={() =>
                      void update({ voiceInputModelId: manifest.id } satisfies Partial<AppSettings>)
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {isSelected ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-brand" aria-hidden />
                    ) : (
                      <CircleIcon
                        className={cn(
                          "size-4 shrink-0",
                          status === "installed" ? "text-fg-subtle" : "text-fg-subtlest",
                        )}
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: manifest.labelKey })}
                    </span>
                    <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-ui-xs text-fg-subtle">
                      {intl.formatMessage({
                        id: `settings.voiceInput.model.${manifest.id}.tag`,
                      })}
                    </span>
                  </button>
                  {downloading ? (
                    <Button type="button" variant="ghost" size="xs" disabled>
                      <LoaderIcon className="size-4 animate-spin" aria-hidden />
                      {`${Math.floor((downloading.receivedBytes / downloading.totalBytes) * 100)}%`}
                    </Button>
                  ) : status === "installed" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={intl.formatMessage({ id: "settings.voiceInput.model.delete" })}
                      onClick={() => void handleDelete(manifest.id)}
                    >
                      <Trash2Icon className="size-4" aria-hidden />
                    </Button>
                  ) : status === "error" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void handleDownload(manifest.id)}
                    >
                      {intl.formatMessage({ id: "settings.voiceInput.download.retry" })}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void handleDownload(manifest.id)}
                    >
                      <DownloadIcon className="size-4" aria-hidden />
                      {intl.formatMessage({ id: "settings.voiceInput.download.action" })}
                    </Button>
                  )}
                </div>
                <div className="pl-6 text-ui-sm text-fg-subtle">
                  {intl.formatMessage({
                    id: `settings.voiceInput.model.${manifest.id}.description`,
                  })}
                </div>
                <div className="pl-6 flex flex-wrap gap-x-4 gap-y-1 text-ui-xs text-fg-subtlest">
                  <span>
                    {intl.formatMessage({ id: "settings.voiceInput.model.disk" })}
                    {formatMb(manifest.approxDiskMb)}
                  </span>
                  <span>
                    {intl.formatMessage({ id: "settings.voiceInput.model.memory" })}
                    {formatMb(manifest.approxRuntimeMemMb[0])}–
                    {formatMb(manifest.approxRuntimeMemMb[1])}
                  </span>
                  <span>
                    {intl.formatMessage({
                      id: manifest.streaming
                        ? "settings.voiceInput.model.streaming"
                        : "settings.voiceInput.model.segmented",
                    })}
                  </span>
                  {downloading ? (
                    <span className="text-brand">
                      {intl.formatMessage(
                        { id: "settings.voiceInput.download.progress" },
                        {
                          file: downloading.activeFile,
                          percent: Math.floor(
                            (downloading.receivedBytes / downloading.totalBytes) * 100,
                          ),
                        },
                      )}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsGroupCard>

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
                  ? `${cleanupSelection.providerId}/${cleanupSelection.modelId}`
                  : intl.formatMessage({ id: "settings.voiceInput.cleanup.modelPlaceholder" })
              }
              showProviderLevel={false}
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
                <kbd className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ui-xs text-fg-subtle">
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
