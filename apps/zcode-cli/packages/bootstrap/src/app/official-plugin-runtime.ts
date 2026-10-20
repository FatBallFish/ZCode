import { findPluginManifestPath } from "@zcode/adapters/plugins";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpStdioServerConfig,
  type McpHttpServerConfig,
  type PluginLoadOutcome,
} from "@zcode/contracts";
import {
  ZCODE_PLUGIN_ID_ENV_KEY,
  buildRuntimeCodingPlanApiUrl,
  type RuntimeZCodeEndpointEnv,
} from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

/** Image Search 默认采用官方账号后端；后续自建 adapter 必须显式提供配置且不继承官方鉴权。 */
export type ImageSearchBackendPort =
  | { kind: "official-coding-plan" }
  | { kind: "custom"; createMcpConfig(existing: McpHttpServerConfig): McpHttpServerConfig };

export function createImageSearchMcpConfig(options: {
  existing: McpHttpServerConfig;
  env?: RuntimeZCodeEndpointEnv;
  backend?: ImageSearchBackendPort;
}): McpHttpServerConfig {
  if (options.backend?.kind === "custom") {
    const {
      auth: _auth,
      official: _official,
      ...config
    } = {
      ...options.existing,
      ...options.backend.createMcpConfig(options.existing),
    };
    return config;
  }
  return {
    ...options.existing,
    // 用户明确授权此搜图后端例外；账号来源独立于自建产品域，不向产品域发送官方凭据。
    url: buildRuntimeCodingPlanApiUrl(options.env ?? {}, "/api/v1/mcp/server/image_search"),
    auth: { type: "zcode_official", provider: "jwt_token" },
  };
}

export function createBundledMcpRuntimeConfig(input: {
  cwd?: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  serverArgs?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpStdioServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      ...(input.serverArgs ?? [
        join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
      ]),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // 桌面打包态 process.execPath 是 ZCode Helper；缺少 Node 模式会误进 Electron main。
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

/** 每个消费者只信任当前进程绑定；共享缓存里的命令前缀不是运行态权威。 */
export function bindOfficialPluginMcpRuntime(
  outcome: PluginLoadOutcome,
  options: {
    env?: RuntimeZCodeEndpointEnv;
    imageSearchBackend?: ImageSearchBackendPort;
  } = {},
): PluginLoadOutcome {
  let mcpServers: PluginLoadOutcome["mcpServers"] | undefined;
  for (const plugin of outcome.plugins) {
    if (
      !plugin.enabled ||
      plugin.marketplace !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ||
      plugin.id !== `${plugin.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`
    )
      continue;
    for (const serverName of plugin.mcpServerNames) {
      if (!serverName.startsWith(`plugin:${plugin.name}:`)) continue;
      const server = outcome.mcpServers[serverName];
      if (
        plugin.name === "image-search" &&
        serverName === "plugin:image-search:image_search" &&
        server?.type === "http"
      ) {
        mcpServers ??= { ...outcome.mcpServers };
        mcpServers[serverName] = createImageSearchMcpConfig({
          existing: server,
          env: options.env,
          backend: options.imageSearchBackend,
        });
        continue;
      }
      if (server?.type !== "stdio") continue;
      const args = server.args ?? [];
      // Bug 根因：共享 manifest 会被测试/旧客户端写入其入口和 Node execArgv；
      // 后来的日常运行若照抄缓存，就启动归档测试而非 MCP。只保留 host 标记后的真实 server 参数。
      const hostMarker = args.indexOf(ZCODE_PLUGIN_HOST_COMMAND);
      const serverArgs = hostMarker < 0 ? args : args.slice(hostMarker + 1);
      if (!serverArgs.length) continue;
      const runtime = createBundledMcpRuntimeConfig({
        rootPath: plugin.rootPath,
        cwd: server.cwd,
        env: server.env,
        serverArgs,
        timeoutMs: server.timeoutMs,
      });
      if (!runtime) continue;
      mcpServers ??= { ...outcome.mcpServers };
      // auth/provenance、isolation、protocol 等业务合同保留；只替换当前进程的启动材料。
      mcpServers[serverName] = { ...server, ...runtime };
    }
  }
  return mcpServers ? { ...outcome, mcpServers } : outcome;
}

interface OfficialRuntimeManifestInput {
  sourceManifestContents?: string;
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = findPluginManifestPath(input.rootPath);
  if (!manifestPath) throw new Error(`Official plugin manifest is missing: ${input.pluginName}`);
  const currentContents = readFileSync(manifestPath, "utf8");
  // 缓存里的入口可能已被旧客户端覆盖，必须从内置原始 manifest 重新生成。
  const manifest = JSON.parse(input.sourceManifestContents ?? currentContents) as Record<
    string,
    unknown
  >;
  // skill-only / command-only 类型的 official plugin 不带 mcpServers，直接跳过 rewrite。
  // 之前这里无脑 asRecord(manifest.mcpServers) 会对 undefined 抛错，
  // 把 seed 流程整个阻断，连带 listZCodeSkills 拉不出 plugin skill。
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // 保留对其他历史 official plugin MCP 的通用重写；zcode-cua 当前是 skill/SDK-only，
  // 不会进入这个分支，也不会生成独立的 CUA MCP server。
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    // HTTP/SSE 插件没有本地入口；按 stdio 校验会让 image-search 阻断整个会话初始化。
    if (mcpServer.type !== undefined && mcpServer.type !== "stdio") continue;
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    const serverArgs =
      input.sourceManifestContents === undefined
        ? [join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)]
        : mcpServer.args;
    if (
      !Array.isArray(serverArgs) ||
      !serverArgs.every((arg): arg is string => typeof arg === "string") ||
      serverArgs.length === 0
    ) {
      throw new Error("Official plugin manifest has invalid MCP server args.");
    }
    mcpServer.command = process.execPath;
    // 文档插件使用 dist/server.mjs；统一覆盖成 dist/mcp/server.js 会导致启动失败。
    mcpServer.args = [
      ...hostPrefixArgs,
      ...serverArgs.map((arg) =>
        arg
          .replaceAll("${MIKIKO_PLUGIN_ROOT}", input.rootPath)
          .replaceAll("${ZCODE_PLUGIN_ROOT}", input.rootPath)
          .replaceAll("${CLAUDE_PLUGIN_ROOT}", input.rootPath),
      ),
    ];
    mcpServer.env = {
      ...mcpServerEnv,
      // 桌面打包态的 process.execPath 是 ZCode Helper。
      // 官方插件 MCP server 缺少 Node 模式 env 时会误进 Electron main，触发 deep-link 注册等桌面副作用。
      ELECTRON_RUN_AS_NODE: "1",
      // 权威写入插件身份（pluginName@marketplace，来自本地 plugin registry，manifest/user env 不可覆盖）。
      // 其他 official plugin 仍带上不可伪造的 plugin identity；CUA broker 凭据由 shared
      // node_repl 的可信配置注入，不再写入独立 server。
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // 启动时无条件 rename 同内容的 plugin.json 会放大 Windows 杀毒/索引器
  // 的短暂文件占用。字节完全一致时不触碰文件；真正有更新时仍保持原子的失败语义。
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
