/**
 * 语音输入的输入设备与麦克风权限设置卡（specs/desktop/voice-input.md §3.4/§3.5）
 * ——从 VoiceInputSettingsSection 拆出（分区超 max-lines）。自包含：设备枚举、
 * 权限状态查询/引导、devicechange 与窗口聚焦刷新。
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, CircleIcon, ShieldAlertIcon } from "lucide-react";
import type { AppSettings, VoiceMicPermissionStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「使用系统默认」的哨兵值：Radix Select 的 SelectItem value 不允许空字符串
 * （空串保留给“清除选择”语义，传了会抛错），而设置里空串=系统默认，进出各映射一次。
 */
const DEVICE_SYSTEM_DEFAULT = "__system-default__";

export function VoiceDevicePermissionCard() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const platform = usePlatform();

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

  return (
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
  );
}
