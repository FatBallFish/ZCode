import { arch, release as osRelease, type as osType } from "node:os";
import {
  CODEX_VERSION_FALLBACK,
  buildCodexIdentityHeaders,
  type CodexIdentityHeaderInput,
  type CodexIdentityHeaders,
} from "@zcode/shared";
import type { MikikoClientConfigService } from "../model-provider/mikikoClientConfigService.js";
import type { ISettingService } from "../setting/setting.js";

/**
 * Codex 身份解析：版本优先级 = 手动覆写 > Mikiko 远端配置 > 内置 fallback（spec §8）。
 * UA 的 terminalToken 定稿为 Mikiko/{appVersion}；模拟关闭时退回 Mikiko 自身标识。
 */

export type ChatGPTServiceTier = "auto" | "fast" | "flex";

export interface ChatGPTIdentityResolver {
  resolveInput(): Promise<CodexIdentityHeaderInput>;
  resolveHeaders(): Promise<CodexIdentityHeaders>;
  resolveServiceTier(): Promise<ChatGPTServiceTier>;
  /** 模型清单 client_version（官方取整版本口径）。 */
  resolveModelsClientVersion(): Promise<string>;
}

export function createChatGPTIdentityResolver(dependencies: {
  settingService: ISettingService;
  mikikoClientConfigService: Pick<MikikoClientConfigService, "getCodexClientVersion">;
  appVersion?: string;
}): ChatGPTIdentityResolver {
  const appVersion = dependencies.appVersion?.trim() || "0.0.0";

  async function resolveVersion(): Promise<string> {
    const settings = await dependencies.settingService.get();
    const override = settings.chatgptCodexVersionOverride?.trim();
    if (override && /^\d+\.\d+\.\d+$/u.test(override)) return override;
    const remote = await dependencies.mikikoClientConfigService.getCodexClientVersion();
    return remote ?? CODEX_VERSION_FALLBACK;
  }

  async function resolveInput(): Promise<CodexIdentityHeaderInput> {
    const [settings, codexVersion] = await Promise.all([
      dependencies.settingService.get(),
      resolveVersion(),
    ]);
    return {
      codexVersion,
      osType: osType(),
      osVersion: osRelease(),
      arch: arch(),
      terminalToken: `Mikiko/${appVersion}`,
      uaSimulation: settings.chatgptCodexUaSimulation !== false,
      appVersion,
    };
  }

  return {
    resolveInput,
    resolveHeaders: async () => buildCodexIdentityHeaders(await resolveInput()),
    async resolveServiceTier() {
      const settings = await dependencies.settingService.get();
      const tier = settings.chatgptServiceTier;
      return tier === "fast" || tier === "flex" ? tier : "auto";
    },
    // client_version 取整（x.y.z → x.y.0；官方 client_version_to_whole 口径）。
    async resolveModelsClientVersion() {
      const version = await resolveVersion();
      const [major, minor] = version.split(".");
      return `${major ?? "0"}.${minor ?? "0"}.0`;
    },
  };
}
