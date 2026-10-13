/**
 * 麦克风权限（specs/desktop/voice-input.md §3.5）。
 * macOS 走 TCC（getMediaAccessStatus / askForMediaAccess）；
 * Windows 无逐应用预检（桌面应用受全局麦克风隐私开关控制，仅提供设置深链引导）；
 * Linux 无统一权限体系（普通构建无需授权）。
 * 依赖注入 systemPreferences/shell/platform 以便单测（同 desktopVoiceService 的注入模式）。
 */
import type { VoiceMicPermissionResult, VoiceMicPermissionStatus } from "@zcode/shared";

export interface MicPermissionDeps {
  /** process.platform 注入。 */
  platform: NodeJS.Platform;
  getMediaAccessStatus(mediaType: "microphone"): string;
  /** Electron 41+ 的 API 名是 askForMediaAccess（旧名 askForMediaAccessPermission 已不存在，
   *  调用会同步抛 TypeError 并被 ensure 捕获成 denied——表现为"永不弹框、瞬间被拒"）。 */
  askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
  openExternal(url: string): Promise<unknown>;
  /**
   * 清除本应用 bundle id 的麦克风 TCC 记录（tccutil reset Microphone <bundleId>）。
   * 仅 dev 装配注入：每次重编译 ad-hoc 签名的 cdhash 都变，旧 deny/授权记录对新副本
   * 失效却又占着 not-determined 之外的档位，askForMediaAccess 从此不再弹框。
   * 生产打包版不注入（用户明确拒绝过的不应被重置）。
   */
  resetMicApproval?: () => Promise<void>;
}

/** macOS 隐私设置里麦克风面板的深链（经典 Security 面板 URL，Ventura+ 仍可跳转）。 */
export const MAC_MIC_PERMISSION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

/** Windows 11/10 麦克风隐私设置（桌面应用受其中全局开关控制）。 */
export const WIN_MIC_PERMISSION_SETTINGS_URL = "ms-settings:privacy-microphone";

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

export interface OpenMicSettingsResult {
  ok: boolean;
  /** darwin 补请求后的最终状态（供 renderer 刷新/浮窗消隐）；未涉及授权时缺省。 */
  status?: VoiceMicPermissionStatus;
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
      const granted = await deps.askForMediaAccess("microphone");
      return { status: granted ? "granted" : "denied" };
    } catch {
      return { status: "denied" };
    }
  }

  /**
   * 「去开启」：macOS 隐私列表只显示申请过权限的应用——若从未触发 TCC 请求，
   * 用户在设置里找不到本应用、只能手动添加。因此 not-determined 时先补一次
   * ask（允许则直接授权完成，拒绝也会把应用写入列表），再跳设置面板；
   * denied（记录已存在）直接跳。dev 构建注入 resetMicApproval 时 denied 先
   * 清 TCC 记录重新 ask（见下方实现注释）。
   */
  async function openSystemSettings(): Promise<OpenMicSettingsResult> {
    if (deps.platform === "win32") {
      try {
        await deps.openExternal(WIN_MIC_PERMISSION_SETTINGS_URL);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }
    if (deps.platform !== "darwin") return { ok: false };
    let final = await ensure();
    // dev 构建（注入 resetMicApproval）遇 denied 先清 TCC 记录再重新 ask：
    // dev bundle 每次重编译 cdhash 变化，历史记录对新副本必然失配，用户既无法
    // 在系统设置里删旧条目也无法手动添加新副本；只有 tccutil reset 能让状态回到
    // not-determined 重新弹框（真机实测结论）。
    if (final.status === "denied" && deps.resetMicApproval) {
      try {
        await deps.resetMicApproval();
        final = await ensure();
      } catch {
        // tccutil 失败（权限不足等）：保持原状态走设置面板引导。
      }
    }
    if (final.status === "granted") {
      // 授权框里已点允许：无需再进设置页。
      return { ok: true, status: "granted" };
    }
    try {
      await deps.openExternal(MAC_MIC_PERMISSION_SETTINGS_URL);
      return { ok: true, status: final.status };
    } catch {
      return { ok: false, status: final.status };
    }
  }

  return { getStatus, ensure, openSystemSettings };
}

export type VoiceMicPermission = ReturnType<typeof createVoiceMicPermission>;
