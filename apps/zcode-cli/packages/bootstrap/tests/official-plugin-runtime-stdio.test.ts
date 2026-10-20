import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type PluginLoadOutcome,
  type PluginMetadata,
} from "@zcode/contracts";
import { bindOfficialPluginMcpRuntime } from "../src/app/official-plugin-runtime.js";

const currentEntry = fileURLToPath(new URL("../../cli/dist/zcode.cjs", import.meta.url));
const originalEntry = process.argv[1];
const originalExecArgv = [...process.execArgv];
afterEach(() => {
  process.argv[1] = originalEntry;
  process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
});

it.each(["pdf", "presentations", "spreadsheets"])(
  "%s starts from the current CLI despite a stale test entry and serves its real UI resources",
  async (name) => {
    const rootPath = fileURLToPath(new URL(`../../${name}-plugin/`, import.meta.url));
    const serverPath = join(rootPath, "dist", "server.mjs");
    await Promise.all([
      stat(currentEntry),
      stat(serverPath),
      stat(join(rootPath, "dist", "ui", "panel.html")),
    ]);
    const workspace = await mkdtemp(join(tmpdir(), `mikiko-${name}-runtime-contract-`));
    process.argv[1] = currentEntry;
    process.execArgv.splice(0);
    const serverName = `plugin:${name}:${name}`;
    const plugin: PluginMetadata = {
      name,
      id: `${name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      enabled: true,
      rootPath,
      manifestPath: join(rootPath, ".mikiko-plugin", "plugin.json"),
      dataPath: workspace,
      mcpServerNames: [serverName],
      declaredMcpServerNames: [name],
      source: "official",
      commandRootCount: 0,
      skillCount: 0,
      skillRootCount: 0,
      components: [],
      hookDetails: [],
    };
    const loaded: PluginLoadOutcome = {
      plugins: [plugin],
      commandRoots: [],
      diagnostics: [],
      hooks: {},
      skillRoots: [],
      mcpServers: {
        [serverName]: {
          type: "stdio",
          command: "/archived/runtime/node",
          args: [
            "--test",
            "--test-concurrency=2",
            "/archived/tests/cwd-option.test.ts",
            ZCODE_PLUGIN_HOST_COMMAND,
            serverPath,
          ],
          cwd: workspace,
          env: { MIKIKO_WORKSPACE_ROOT: workspace },
        },
      },
    };
    const config = bindOfficialPluginMcpRuntime(loaded).mcpServers[serverName];
    if (config?.type !== "stdio") throw new Error("missing bound stdio config");
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...config.env, MIKIKO_DATA_BASE_DIR: workspace },
      stderr: "pipe",
    });
    const client = new Client({ name: "mikiko-runtime-contract", version: "1" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBeTruthy();
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === "open_document")?._meta).toMatchObject({
        ui: { resourceUri: `ui://${name}/panel.html`, surface: name },
      });
      const panel = await client.readResource({ uri: `ui://${name}/panel.html` });
      expect(panel.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(panel.contents[0]).toMatchObject({ text: expect.stringContaining('<div id="root">') });
      const manifest = await client.readResource({ uri: `ui://${name}/assets/assets.json` });
      const content = manifest.contents[0];
      if (!content || !("text" in content)) throw new Error("missing UI assets manifest");
      const assets = JSON.parse(content.text) as { scripts: string[] };
      expect(assets.scripts.length).toBeGreaterThan(0);
      const script = await client.readResource({ uri: `ui://${name}/assets/${assets.scripts[0]}` });
      expect(script.contents[0]).toMatchObject({ text: expect.any(String) });
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  },
  20_000,
);
