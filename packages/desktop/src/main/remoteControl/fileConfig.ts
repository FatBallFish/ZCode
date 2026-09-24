import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 远控配置文件（spec §21.10）：`~/.mikiko/remote-control.json`。
 *
 * 职责拆到本模块（不依赖 electron，node:test 可直接加载）：
 * - `ensureRemoteControlFileConfig`：App 启动幂等自检——文件不存在则写入默认值
 *   （默认指向 mikiko.ai 生产端点，enabled=true），存在（含用户自定义）则不操作。
 * - `readRemoteControlFileConfig`：读取解析（无文件/解析失败按空配置处理）。
 *
 * 顶层 `enabled` 是手机扫码直连的功能开关：false 时 start 不生效、UI 展示停用态
 * （`disabledReason: "config"`）；Bot 渠道与远控入口展示不受它影响。
 */
export interface RemoteControlFileConfig {
  relayWsUrl?: unknown;
  relayHttpUrl?: unknown;
  stunUrls?: unknown;
  deviceName?: unknown;
  enabled?: unknown;
}

/** 默认配置：mikiko.ai 生产端点（spec §19 域名定稿）。stunUrls 缺省走 wiring 内置列表。 */
export const REMOTE_CONTROL_DEFAULT_FILE_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  enabled: true,
  relayWsUrl: "wss://ws.mikiko.ai/ws/desktop",
  relayHttpUrl: "https://ws.mikiko.ai",
});

export function remoteControlConfigPath(): string {
  return join(homedir(), ".mikiko", "remote-control.json");
}

export function readRemoteControlFileConfig(
  configPath: string = remoteControlConfigPath(),
): RemoteControlFileConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as RemoteControlFileConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {}; // 无配置文件/解析失败都按未配置处理（默认零出网）。
  }
}

/**
 * 启动自检（幂等）：不存在则写默认值，存在则不操作（保留用户自定义）。
 * 返回 created（已生成默认）/ exists（保持原样）/ failed（写入失败，不影响启动）。
 */
export function ensureRemoteControlFileConfig(
  configPath: string = remoteControlConfigPath(),
): "created" | "exists" | "failed" {
  try {
    if (existsSync(configPath)) {
      return "exists";
    }
    const configDir = dirname(configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(
      configPath,
      `${JSON.stringify(REMOTE_CONTROL_DEFAULT_FILE_CONFIG, null, 2)}\n`,
      "utf8",
    );
    return "created";
  } catch {
    // 写入失败（目录只读/磁盘满等）不阻断启动：读取侧按空配置处理即可。
    return "failed";
  }
}
