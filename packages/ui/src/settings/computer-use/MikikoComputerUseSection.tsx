import type { MikikoComputerUsePermissionSnapshot } from "./types.js";
import { useMikikoComputerUseActions } from "@/hooks/useMikikoComputerUseActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "../SettingsPageParts.js";
import { StatusDot } from "../StatusDot.js";

export function MikikoComputerUseSection(props: {
  enabled: boolean;
  toggling: boolean;
  workspacePath: string | null;
  workspaceIdentity?: string;
  status: MikikoComputerUsePermissionSnapshot | null;
  onToggle(enabled: boolean): Promise<unknown>;
  refresh(): void;
  composerVisible: boolean;
  composerSaving: boolean;
  onToggleComposer(visible: boolean): Promise<unknown>;
  /**
   * 是否渲染 macOS 权限区（辅助功能/屏幕录制行、授权目标提示与权限应用重启引导）。
   * 默认 true（macOS 分支）；Windows/Linux 实验平台传 false——那边无 TCC 概念，
   * 且权限状态未订阅、workspacePath 为 null，重启按钮会永远置灰，整区隐藏只保留
   * 总开关与输入框入口开关（docs/specs/computer-use-experimental-platforms.md）。
   */
  showMacPermissions?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { restarting, openSettings, restart } = useMikikoComputerUseActions(props);
  const showMacPermissions = props.showMacPermissions ?? true;
  const status = props.status && props.status.available !== false ? props.status : null;
  const native = status as typeof status & { backend?: string; appPath?: string };
  const appPath = native?.backend === "mikiko-native" ? native.appPath : undefined;
  const text = (id: string) => intl.formatMessage({ id });
  return (
    <div className="space-y-4" data-testid="mikiko-computer-use-settings">
      <SettingsGroupCard>
        <SettingsRow
          label={text("settings.computerUse.toggleLabel")}
          description={text("settings.computerUse.native.description")}
          control={
            <Switch
              aria-label={text("settings.computerUse.toggleLabel")}
              checked={props.enabled}
              disabled={props.toggling || !props.workspacePath}
              onCheckedChange={(value) => void props.onToggle(value)}
            />
          }
        />
        <SettingsRow
          label={text("settings.computerUse.composerEntry.label")}
          description={text(
            props.enabled
              ? "settings.computerUse.composerEntry.description"
              : "settings.computerUse.composerEntry.requiresEnabled",
          )}
          control={
            <Switch
              aria-label={text("settings.computerUse.composerEntry.label")}
              checked={props.composerVisible}
              disabled={!props.enabled || props.composerSaving}
              onCheckedChange={(value) => void props.onToggleComposer(value)}
            />
          }
        />
      </SettingsGroupCard>
      {props.enabled && showMacPermissions ? (
        <>
          <SettingsGroupCard>
            {(["accessibility", "screen_recording"] as const).map((kind) => {
              const granted =
                (kind === "accessibility" ? status?.accessibility : status?.screenRecording) ===
                "granted";
              const permissionState =
                kind === "accessibility" ? status?.accessibility : status?.screenRecording;
              const known =
                permissionState === "granted" ||
                permissionState === "denied" ||
                permissionState === "stale";
              const permission = kind === "accessibility" ? "accessibility" : "screenRecording";
              const label =
                kind === "accessibility"
                  ? "chat.cuaPermission.openAccessibility"
                  : "chat.cuaPermission.openScreenRecording";
              return (
                <SettingsRow
                  key={kind}
                  controlLayout="wide"
                  label={text(`cuaPermission.perm.${permission}`)}
                  description={text(`cuaPermission.perm.${permission}.purpose`)}
                  control={
                    <SettingsBadge>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone={granted ? "green" : known ? "red" : "muted"} />
                        {text(
                          granted
                            ? "cuaPermission.status.granted"
                            : known
                              ? "cuaPermission.status.missing"
                              : "cuaPermission.status.unknown",
                        )}
                      </span>
                    </SettingsBadge>
                  }
                  detail={
                    !granted ? (
                      <Button
                        variant="link"
                        size="sm"
                        disabled={!appPath}
                        onClick={() => void openSettings(kind)}
                      >
                        {text(label)}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </SettingsGroupCard>
          {appPath ? (
            <div className="space-y-1 text-ui-sm text-foreground-subtle">
              <p>{text("settings.computerUse.native.permissionApp")}</p>
              <code
                className="block select-text break-all text-ui-caption"
                data-testid="mikiko-computer-use-grant-target"
              >
                {appPath}
              </code>
            </div>
          ) : (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {props.status && props.status.available === false
                ? props.status.reason
                : text("common.loading")}
            </p>
          )}
          <div className="space-y-2">
            <p className="text-ui-sm text-foreground-subtle">
              {text("settings.computerUse.native.restartHint")}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={restarting || !props.workspacePath}
              onClick={() => void restart()}
            >
              {text(
                restarting ? "cuaPermission.modal.restarting" : "cuaPermission.modal.restartButton",
              )}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
