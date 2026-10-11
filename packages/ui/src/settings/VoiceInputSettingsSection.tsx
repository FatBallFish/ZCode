/**
 * 语音输入设置（specs/desktop/voice-input.md §3.1/§3.4/§3.5）：
 * 识别模型卡（特点/磁盘/内存/下载状态）、输入设备与麦克风权限、语义整理开关与模型选择
 * （复用 ModelConfigSelect）、快捷键展示与跳转、引擎占用与「立即释放」。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, CheckCircle2Icon, CircleIcon, ShieldAlertIcon } from "lucide-react";
import {
  DEFAULT_VOICE_MODEL_ID,
  ZCODE_AGENT_PROVIDER,
  type AppSettings,
  type VoiceMicPermissionStatus,
  type VoiceStateSnapshot,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
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
import { VoiceModelCardList } from "@/settings/VoiceModelCardList.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";

const MODEL_ITEM_NEVER_LOCKED = () => false;

/**
 * 「使用系统默认」的哨兵值：Radix Select 的 SelectItem value 不允许空字符串
 * （空串保留给“清除选择”语义，传了会抛错），而设置里空串=系统默认，进出各映射一次。
 */
const DEVICE_SYSTEM_DEFAULT = "__system-default__";

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

  // ── 输入设备（spec §3.4）：enumerateDevices + devicechange/聚焦刷新 ──
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) =>
        // deviceId 为空的条目不进下拉：Radix SelectItem 不接受空串 value（同默认项哨兵原因）。
        setDevices(all.filter((device) => device.kind === "audioinput" && device.deviceId !== "")),
      )
      .catch(() => undefined);
  }, []);
  const selectedDeviceId = settings?.voiceInputDeviceId ?? "";
  const selectedDeviceMissing =
    selectedDeviceId !== "" && !devices.some((device) => device.deviceId === selectedDeviceId);

  // ── 麦克风权限（spec §3.5）：状态查询 + 聚焦刷新（用户从系统设置改完回来的场景）──
  const permissionSupported = typeof platform.voiceGetMicPermissionStatus === "function";
  const [micPermission, setMicPermission] = useState<VoiceMicPermissionStatus | null>(null);
  const refreshMicPermission = useCallback(() => {
    if (!permissionSupported) return;
    platform
      .voiceGetMicPermissionStatus?.()
      .then((result) => setMicPermission(result.status))
      .catch(() => undefined);
  }, [permissionSupported, platform]);

  useEffect(() => {
    refreshDevices();
    refreshMicPermission();
    const onDeviceChange = () => {
      refreshDevices();
    };
    // 授权/系统设置变更后回到窗口时刷新两类状态。
    const onFocus = () => {
      refreshDevices();
      refreshMicPermission();
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    window.addEventListener("focus", onFocus);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshDevices, refreshMicPermission]);

  const handleOpenMicSettings = useCallback(() => {
    // macOS 补请求流程可能直接完成授权：返回后立即刷新状态行，不等窗口 focus。
    void platform
      .voiceOpenMicPermissionSettings?.()
      .catch(() => null)
      .finally(() => refreshMicPermission());
  }, [platform, refreshMicPermission]);

  let permissionLabelId: string | null = null;
  if (micPermission === "granted") permissionLabelId = "settings.voiceInput.permission.granted";
  else if (micPermission === "denied" || micPermission === "restricted")
    permissionLabelId = "settings.voiceInput.permission.denied";
  else if (micPermission === "not-determined")
    permissionLabelId = "settings.voiceInput.permission.notDetermined";
  const permissionBlocked = micPermission === "denied" || micPermission === "restricted";

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

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.voiceInput.device.title" })}
          description={
            selectedDeviceMissing
              ? intl.formatMessage({ id: "settings.voiceInput.device.missing" })
              : intl.formatMessage({ id: "settings.voiceInput.device.description" })
          }
          control={
            <Select
              value={selectedDeviceId || DEVICE_SYSTEM_DEFAULT}
              onValueChange={(value) =>
                void update({
                  voiceInputDeviceId: value === DEVICE_SYSTEM_DEFAULT ? "" : value,
                } satisfies Partial<AppSettings>)
              }
            >
              <SelectTrigger
                className="h-8 w-56 shrink-0"
                data-testid="voice-input-device-select"
                aria-label={intl.formatMessage({ id: "settings.voiceInput.device.title" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEVICE_SYSTEM_DEFAULT} data-testid="voice-input-device-default">
                  {intl.formatMessage({ id: "settings.voiceInput.device.default" })}
                </SelectItem>
                {devices.map((device, index) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label ||
                      intl.formatMessage(
                        { id: "settings.voiceInput.device.unnamed" },
                        { index: index + 1 },
                      )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {permissionSupported ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.voiceInput.permission.title" })}
            description={
              permissionBlocked
                ? intl.formatMessage({ id: "settings.voiceInput.permission.deniedDescription" })
                : undefined
            }
            control={
              <div className="flex items-center gap-2">
                {permissionLabelId ? (
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-ui-sm",
                      permissionBlocked ? "text-warning" : "text-fg-subtle",
                    )}
                    data-testid="voice-mic-permission-status"
                  >
                    {permissionBlocked ? (
                      <ShieldAlertIcon className="size-4" aria-hidden />
                    ) : micPermission === "granted" ? (
                      <CheckCircle2Icon className="size-4 text-success" aria-hidden />
                    ) : (
                      <CircleIcon className="size-4" aria-hidden />
                    )}
                    {intl.formatMessage({ id: permissionLabelId })}
                  </span>
                ) : null}
                {permissionBlocked ? (
                  <Button type="button" variant="outline" size="xs" onClick={handleOpenMicSettings}>
                    {intl.formatMessage({ id: "settings.voiceInput.permission.openSettings" })}
                  </Button>
                ) : null}
              </div>
            }
          />
        ) : null}
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
