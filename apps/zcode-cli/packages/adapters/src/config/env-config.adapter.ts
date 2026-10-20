// Env Config Adapter - Parse the intentionally small MIKIKO_* environment surface.

import type { RuntimeConfigPatch } from "@zcode/contracts";

interface EnvConfigOptions {
  prefix?: string;
}

/**
 * Parse Mikiko environment variables with legacy namespace read compatibility
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): RuntimeConfigPatch {
  // 历史命名先读、新品牌后覆盖，避免配置目录因 env 枚举顺序或升级而错位。
  const prefixes = options.prefix !== undefined ? [options.prefix] : ["ZCODE_", "MIKIKO_"];
  const config: RuntimeConfigPatch = {};

  for (const prefix of prefixes) {
    for (const [key, value] of Object.entries(env)) {
      if (!key.startsWith(prefix) || value === undefined) continue;

      const configKey = key.slice(prefix.length);
      // Storage config
      if (configKey === "STORAGE_DIR") {
        if (!config.storage) config.storage = {};
        config.storage.dir = value;
      } else if (configKey === "SESSION_DB_PATH" || configKey === "SESSION_DB") {
        if (!config.storage) config.storage = {};
        config.storage.sessionDbPath = value;
      }

      // Network config
      else if (configKey === "HTTP_PROXY") {
        if (!config.network) config.network = {};
        config.network.httpProxy = value;
      } else if (configKey === "NO_PROXY") {
        if (!config.network) config.network = {};
        config.network.noProxy = value;
      } else if (configKey === "AGENT_CA_CERT") {
        if (!config.network) config.network = {};
        config.network.caCertFile = value;
      } else if (configKey === "HTTP_TIMEOUT" || configKey === "TIMEOUT") {
        if (!config.network) config.network = {};
        config.network.timeout = normalizeNumber(value);
      }

      // Logging config
      else if (configKey === "LOG_FORMAT") {
        if (!config.logging) config.logging = {};
        config.logging.format = normalizeLogFormat(value);
      }

      // Tool Concurrency config
      else if (configKey === "MAX_TOOL_CONCURRENCY") {
        if (!config.toolConcurrency) config.toolConcurrency = {};
        config.toolConcurrency.maxConcurrency = normalizeNumber(value);
      }
    }
  }
  return config;
}

/**
 * Get tool concurrency config from environment
 */
export function getToolConcurrencyConfig(): { maxConcurrency: number } {
  return {
    maxConcurrency: normalizeNumber(
      process.env.MIKIKO_MAX_TOOL_CONCURRENCY ?? process.env.ZCODE_MAX_TOOL_CONCURRENCY ?? "10",
    ),
  };
}

// ============================================================
// Helpers
// ============================================================

function normalizeNumber(value: string): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function normalizeLogFormat(value: string): "text" | "json" {
  const format = value.toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  return "text";
}
