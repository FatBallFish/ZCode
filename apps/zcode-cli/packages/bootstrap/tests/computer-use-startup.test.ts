import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConfig } from "@zcode/adapters/config";
import type { Logger, ModelRequest } from "@zcode/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import { resolveStartupPlugins } from "../src/app/startup-marks.js";
import { StartupTimer } from "../src/startup-logging.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const PLUGIN_ID = "computer-use@zcode-plugins-official";
const SERVER = "plugin:computer-use:computer-use";
const TOOL = "mcp__plugin_computer-use_computer-use__list_apps";
const require = createRequire(import.meta.url);
const logger: Logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };
const originalEntry = process.argv[1];
const originalExecArgv = [...process.execArgv];

describe("Computer Use session startup", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mikiko-cua-startup-"));
    env = {
      MIKIKO_STORAGE_DIR: join(root, "storage"),
      MIKIKO_COMPUTER_USE_BINARY: join(root, "Mikiko Computer Use.app", "Contents/MacOS/mikiko-computer-use"),
      MIKIKO_COMPUTER_USE_APP_PATH: join(root, "Mikiko Computer Use.app"),
      MIKIKO_COMPUTER_USE_SERVER: join(root, "production-server.mjs"),
    };
  });

  afterEach(async () => {
    process.argv[1] = originalEntry;
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    await rm(root, { recursive: true, force: true });
  });

  function startup(enabled?: boolean, resources = env) {
    const configResult = createConfig({ env: resources, skipUserConfig: true, workingDirectory: root });
    if (enabled !== undefined) configResult.config.plugins.enabledPlugins[PLUGIN_ID] = enabled;
    const outcome = resolveStartupPlugins({
      cliStorageRoot: join(root, "cli"), configResult, env: resources,
      options: { pluginStorageRoot: join(root, "plugins") },
      startupTimer: new StartupTimer(logger, {}), workingDirectory: root,
    });
    const runtime = resolveAppRuntimeConfig({
      cliStorageRoot: join(root, "cli"), configResult, options: { env: resources },
      pluginMcpServers: outcome.mcpServers, workingDirectory: root,
      subagentOutputRootDir: join(root, "agents"),
    });
    return { outcome, runtime };
  }

  it("binds the enabled plugin before legacy CUA filtering in runtime configuration", () => {
    const { outcome, runtime } = startup(true);
    expect(outcome.plugins.find((plugin) => plugin.id === PLUGIN_ID)?.enabled).toBe(true);
    const config = runtime.runtimeConfig.mcp?.servers[SERVER];
    expect(config).toMatchObject({
      type: "stdio", isolation: "session", command: process.execPath,
      env: {
        MIKIKO_COMPUTER_USE_BACKEND: "open-computer-use", MIKIKO_COMPUTER_USE_MODE: "production",
        MIKIKO_COMPUTER_USE_BINARY: env.MIKIKO_COMPUTER_USE_BINARY,
      },
    });
    expect(config?.type === "stdio" && config.args?.at(-1)).toBe(env.MIKIKO_COMPUTER_USE_SERVER);
  });

  it.each([undefined, false])("keeps Computer Use opt-in with enabled=%s", (enabled) => {
    const { outcome, runtime } = startup(enabled);
    expect(outcome.plugins.find((plugin) => plugin.id === PLUGIN_ID)?.enabled).toBe(false);
    expect(runtime.runtimeConfig.mcp?.servers[SERVER]).toBeUndefined();
  });

  it("disables missing resources without falling back to the retired SDK", () => {
    const { outcome, runtime } = startup(true, { MIKIKO_STORAGE_DIR: env.MIKIKO_STORAGE_DIR });
    expect(outcome.mcpServers[SERVER]?.enabled).toBe(false);
    expect(runtime.runtimeConfig.mcp?.servers[SERVER]?.enabled ?? false).toBe(false);
  });

  it("also applies the shared official Image Search binding at session startup", () => {
    const { outcome } = startup(false, { MIKIKO_ENV: "production", MIKIKO_BASE_URL: "https://product.example.test" });
    expect(outcome.mcpServers["plugin:image-search:image_search"]).toMatchObject({
      type: "http", url: "https://zcode.z.ai/api/v1/mcp/server/image_search",
      auth: { type: "zcode_official", provider: "jwt_token" },
    });
  });

  it("discovers a real stdio tool, exposes it to the session model and executes the call", async () => {
    // MCP/model夹具仅验证会话装配，不把它的返回值当成真实原生控制验收。
    process.argv[1] = fileURLToPath(new URL("../../cli/dist/zcode.cjs", import.meta.url));
    process.execArgv.splice(0);
    const calls = join(root, "gateway-calls.log");
    const gateway = env.MIKIKO_COMPUTER_USE_SERVER!;
    const starts = join(root, "gateway-main.log");
    await writeFile(gateway, `
      import { appendFile } from 'node:fs/promises';
      import { Server } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server")).href)};
      import { serveStdio } from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href)};
      export async function main() {
      await appendFile(${JSON.stringify(starts)},process.pid+'\\n');
      const server = new Server({name:'mikiko-startup-fixture',version:'1'},{capabilities:{tools:{}}});
      server.setRequestHandler('tools/list',async()=>({tools:[{name:'list_apps',description:'List controlled fixture apps',inputSchema:{type:'object',properties:{}}}]}));
      server.setRequestHandler('tools/call',async()=>{
        await appendFile(${JSON.stringify(calls)},'called\\n');
        return {content:[{type:'text',text:'startup-native-fixture-ok'}]};
      });
      serveStdio(()=>server,{legacy:'reject'});
      }
    `);
    const userConfigPath = join(root, "config.json");
    await writeFile(userConfigPath, JSON.stringify({
      storage: { dir: env.MIKIKO_STORAGE_DIR },
      plugins: { enabledPlugins: Object.fromEntries(OFFICIAL_PLUGIN_DEFINITIONS.map((p) => [
        `${p.name}@zcode-plugins-official`, p.name === "computer-use",
      ])) },
    }));
    const modelRequests: ModelRequest[] = [];
    const diagnostics: unknown[] = [];
    const testLogger: Logger = { ...logger, child: () => testLogger, warn: (...args) => { diagnostics.push(args); }, error: (...args) => { diagnostics.push(args); } };
    const app = await createRegistryBackedTestApp({
      env, userConfigPath, pluginStorageRoot: join(root, "plugins"),
      loggerFactory: { createLogger: () => testLogger, withContext: () => testLogger, setLevel() {} },
      runtimeConfig: { workingDirectory: root, mode: "yolo", toolSearch: { mode: "off" } },
      modelExecutor: {
        async generateText(request) {
          modelRequests.push(request);
          const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
          if (modelRequests.length === 1) {
            expect(request.tools?.map((tool) => tool.name), JSON.stringify(diagnostics)).toContain(TOOL);
            return { text: "", finishReason: "tool-calls", usage,
              toolCalls: [{ id: "startup-list-apps", name: TOOL, input: {} }] };
          }
          return { text: "done", finishReason: "stop", usage };
        },
      },
    });
    try {
      await app.submitPrompt("List controlled fixture apps once.");
      expect(modelRequests.length).toBe(2);
      expect(JSON.stringify(modelRequests[1]?.messages)).toContain("startup-native-fixture-ok");
      expect(await readFile(calls, "utf8")).toBe("called\n");
      const startedPids = (await readFile(starts, "utf8")).trim().split("\n");
      expect(startedPids.length).toBeGreaterThan(0);
      expect(new Set(startedPids).size).toBe(startedPids.length);
    } finally {
      await app.close();
    }
  }, 20_000);
});
