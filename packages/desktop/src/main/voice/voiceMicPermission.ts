/**
 * 麦克风权限（specs/desktop/voice-input.md §3.5）。
 * macOS 走 TCC（getMediaAccessStatus / askForMediaAccessPermission）；
 * 其余平台无预检语义（授权交给 getUserMedia 的系统级提示）。
 * 依赖注入 systemPreferences/shell/platform 以便单测（同 desktopVoiceService 的注入模式）。
 */
import type { VoiceMicPermissionResult, VoiceMicPermissionStatus } from "@zcode/shared";

export interface MicPermissionDeps {
  /** process.platform 注入。 */
  platform: NodeJS.Platform;
  getMediaAccessStatus(mediaType: "microphone"): string;
  askForMediaAccessPermission(mediaType: "microphone"): Promise<boolean>;
  openExternal(url: string): Promise<unknown>;
}

/** macOS 隐私设置里麦克风面板的深链（经典 Security 面板 URL，Ventura+ 仍可跳转）。 */
export const MAC_MIC_PERMISSION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

function normalizeDarwinStatus(raw: string): VoiceMicPermissionStatus {
  switch (raw) {
    case "granted":
    case "denied":
    case "restricted":
    case "not-determined":
      return raw;
    default:
      // 未知枚举值按未授权处理，保守拒绝而不是误放行。
      return "denied";
  }
}

export function createVoiceMicPermission(deps: MicPermissionDeps) {
  /** 查询当前状态；非 darwin 无预检语义。 */
  function getStatus(): VoiceMicPermissionResult {
    if (deps.platform !== "darwin") return { status: "unsupported" };
    return { status: normalizeDarwinStatus(deps.getMediaAccessStatus("microphone")) };
  }

  /** not-determined 时弹系统授权框；denied 状态下系统不会重复弹，直接返回。 */
  async function ensure(): Promise<VoiceMicPermissionResult> {
    if (deps.platform !== "darwin") return { status: "granted" };
    const current = getStatus().status;
    if (current !== "not-determined") return { status: current };
    // ask 返回布尔（用户选择），以实际授予为准；异常按拒绝处理（不向上抛打崩调用链）。
    try {
      const granted = await deps.askForMediaAccessPermission("microphone");
      return { status: granted ? "granted" : "denied" };
    } catch {
      return { status: "denied" };
    }
  }

  async function openSystemSettings(): Promise<{ ok: boolean }> {
    if (deps.platform !== "darwin") return { ok: false };
    try {
      await deps.openExternal(MAC_MIC_PERMISSION_SETTINGS_URL);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  return { getStatus, ensure, openSystemSettings };
}

export type VoiceMicPermission = ReturnType<typeof createVoiceMicPermission>;
