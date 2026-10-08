import { parseExternalCdpConfiguration } from "@zcode/adapters/browser";
import {
  DEFAULT_EXTERNAL_CDP_CONFIGURATION,
  EXTERNAL_CDP_CONFIGURATION_ENV,
  EXTERNAL_CDP_REMOTE_CONTROL_ENV,
  type AppSettings,
} from "@zcode/shared";

/**
 * 外部浏览器（external CDP）配置解析。唯一解析者是 main（spec：单一写入路径），
 * host 只消费 main 注入/推送的最终值。
 *
 * 优先级：settings.externalCdpConfig（设置页保存过）> MIKIKO_EXTERNAL_CDP env > 内置默认（9333）。
 * 远控开关：settings.externalCdpRemoteControlEnabled（undefined 跟随 env）> env !== "0"。
 */
export interface ExternalCdpRuntimeConfig {
  /** 已解析+校验的最终 instances JSON。 */
  config: string;
  /** 手机远控 live 会话能否使用外部浏览器。 */
  remoteControlEnabled: boolean;
}

export function validateExternalCdpConfiguration(
  value: string,
): { ok: true } | { ok: false; error: string } {
  try {
    parseExternalCdpConfiguration(value);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveExternalCdpRuntimeConfig(input: {
  settings?: Pick<AppSettings, "externalCdpConfig" | "externalCdpRemoteControlEnabled">;
  env?: Record<string, string | undefined>;
}): ExternalCdpRuntimeConfig {
  const env = input.env ?? process.env;
  const envConfig = env[EXTERNAL_CDP_CONFIGURATION_ENV];
  let config: string;
  if (input.settings?.externalCdpConfig !== undefined) {
    // 设置值非法（如手工编辑 settings 文件）时回退 env/默认，不能把坏配置塞给 host。
    config = validateExternalCdpConfiguration(input.settings.externalCdpConfig).ok
      ? input.settings.externalCdpConfig
      : (envConfig ?? DEFAULT_EXTERNAL_CDP_CONFIGURATION);
  } else {
    config = envConfig ?? DEFAULT_EXTERNAL_CDP_CONFIGURATION;
  }
  const settingsFlag = input.settings?.externalCdpRemoteControlEnabled;
  return {
    config,
    remoteControlEnabled:
      settingsFlag !== undefined ? settingsFlag : env[EXTERNAL_CDP_REMOTE_CONTROL_ENV] !== "0",
  };
}

/** spawn 注入 / 变更推送共用的 env 片段：写入 host 进程环境。 */
export function buildExternalCdpEnvPatch(
  runtime: ExternalCdpRuntimeConfig,
): Record<string, string> {
  return {
    [EXTERNAL_CDP_CONFIGURATION_ENV]: runtime.config,
    [EXTERNAL_CDP_REMOTE_CONTROL_ENV]: runtime.remoteControlEnabled ? "1" : "0",
  };
}
