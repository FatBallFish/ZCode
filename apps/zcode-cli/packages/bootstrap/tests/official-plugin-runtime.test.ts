import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig, PluginLoadOutcome, PluginMetadata } from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts";
import {
  bindOfficialPluginMcpRuntime,
  createImageSearchMcpConfig,
  writeOfficialPluginRuntimeManifest,
} from "../src/app/official-plugin-runtime.js";

describe("official plugin runtime manifest", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];
  const originalExecArgv = [...process.execArgv];

  it("binds Computer Use to the production gateway without legacy broker credentials", () => {
    const key = "plugin:computer-use:computer-use";
    const original = outcome({ [key]: { type: "stdio", command: "old-node", args: ["old-sdk"],
      env: { ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/old/socket", MIKIKO_COMPUTER_USE_BACKEND: "untrusted" } } }, [plugin("computer-use", [key])]);
    const env = { MIKIKO_COMPUTER_USE_BINARY: "/bundle/Mikiko Computer Use.app/Contents/MacOS/mikiko-computer-use",
      MIKIKO_COMPUTER_USE_APP_PATH: "/bundle/Mikiko Computer Use.app", MIKIKO_COMPUTER_USE_SERVER: "/bundle/production-server.mjs" };
    const result = bindOfficialPluginMcpRuntime(original, { env });
    expect(result.mcpServers[key]).toMatchObject({ type: "stdio", isolation: "session", command: process.execPath,
      env: { ...env, MIKIKO_COMPUTER_USE_BACKEND: "open-computer-use", MIKIKO_COMPUTER_USE_MODE: "production", ELECTRON_RUN_AS_NODE: "1" } });
    const config = result.mcpServers[key];
    expect(config?.type === "stdio" && config.args?.at(-1)).toBe(env.MIKIKO_COMPUTER_USE_SERVER);
    expect(config?.type === "stdio" && config.env?.ZCODE_CUA_PERMISSION_BROKER_SOCKET).toBeUndefined();
    expect(original.mcpServers[key]).toMatchObject({ command: "old-node", args: ["old-sdk"] });
  });

  it("does not start a Computer Use MCP when the production resources are missing", () => {
    const key = "plugin:computer-use:computer-use";
    const result = bindOfficialPluginMcpRuntime(outcome({ [key]: { type: "stdio", command: "node", args: ["legacy"] } }, [plugin("computer-use", [key])]), { env: {} });
    expect(result.mcpServers[key]?.enabled).toBe(false);
  });

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("does not rewrite an unchanged runtime manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-runtime-manifest-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    await writeJson(manifestPath, {
      mcpServers: {
        "browser-use": {
          args: [],
          command: "old-node",
        },
      },
      name: "browser-use",
    });
    process.argv[1] = join(root, "zcode.cjs");

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });
    const expectedContents = await readFile(manifestPath, "utf8");
    const firstStat = await stat(manifestPath);
    await delay(30);

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });
    const secondStat = await stat(manifestPath);

    expect(await readFile(manifestPath, "utf8")).toBe(expectedContents);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it.each([".mikiko-plugin", ".zcode-plugin", ".claude-plugin"])(
    "repairs %s cached entries from the seed and leaves HTTP servers untouched",
    async (directory) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-plugin-entry-"));
      cleanups.push(root);
      const manifestPath = join(root, directory, "plugin.json");
      await writeJson(manifestPath, {
        mcpServers: { pdf: { command: "node", args: ["wrong.js"] } },
      });
      process.argv[1] = join(root, "zcode.cjs");
      const remote = { type: "http", url: "https://example.com/mcp" };
      const sourceManifestContents = JSON.stringify({
        mcpServers: {
          pdf: { command: "node", args: ["${MIKIKO_PLUGIN_ROOT}/dist/server.mjs", "--flag"] },
          search: remote,
        },
      });
      const input = { pluginName: "pdf", rootPath: root, sourceManifestContents };
      writeOfficialPluginRuntimeManifest(input);
      const contents = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(contents);
      expect(manifest.mcpServers.pdf.args.slice(-2)).toEqual([
        join(root, "dist/server.mjs"),
        "--flag",
      ]);
      expect(manifest.mcpServers.pdf.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(manifest.mcpServers.search).toEqual(remote);
      writeOfficialPluginRuntimeManifest(input);
      expect(await readFile(manifestPath, "utf8")).toBe(contents);
    },
  );

  it("keeps invalid mcpServers structural errors fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-runtime-invalid-"));
    cleanups.push(root);
    await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
      mcpServers: "invalid",
      name: "browser-use",
    });
    process.argv[1] = join(root, "zcode.cjs");

    expect(() =>
      writeOfficialPluginRuntimeManifest({
        pluginName: "browser-use",
        rootPath: root,
      }),
    ).toThrow("Official plugin manifest has invalid mcpServers.");
  });

  it("binds stale cached stdio entries to this runtime while retaining server arguments and business config", () => {
    process.argv[1] = "/fixture/current/mikiko.cjs";
    process.execArgv.splice(0, process.execArgv.length, "--conditions=module");
    const name = "plugin:pdf:pdf";
    const input = outcome(
      {
        [name]: {
          type: "stdio",
          command: "/fixture/old/node",
          args: [
            "--test",
            "--test-concurrency=2",
            "/archived/tests/cwd-option.test.ts",
            ZCODE_PLUGIN_HOST_COMMAND,
            "/fixture/pdf/dist/server.mjs",
            "--flag",
            "value",
          ],
          cwd: "/fixture/workspace",
          env: { FIXTURE: "kept", ELECTRON_RUN_AS_NODE: "0" },
          auth: { type: "zcode_official", provider: "jwt_token" },
          timeoutMs: 90000,
          isolation: "workspace",
          protocolVersion: "2025-06-18",
        },
      },
      [plugin("pdf", [name])],
    );
    const before = structuredClone(input);
    const bound = bindOfficialPluginMcpRuntime(input);
    expect(bound).not.toBe(input);
    expect(bound.mcpServers).not.toBe(input.mcpServers);
    expect(bound.plugins).toBe(input.plugins);
    expect(bound.mcpServers[name]).toEqual({
      ...input.mcpServers[name],
      command: process.execPath,
      args: [
        "--conditions=module",
        "/fixture/current/mikiko.cjs",
        ZCODE_PLUGIN_HOST_COMMAND,
        "/fixture/pdf/dist/server.mjs",
        "--flag",
        "value",
      ],
      env: { FIXTURE: "kept", ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(input).toEqual(before);
  });

  it("accepts raw server args and rebinds an earlier outcome again for the next process entry", () => {
    const name = "plugin:pdf:pdf";
    const input = outcome(
      {
        [name]: { type: "stdio", command: "node", args: ["/fixture/pdf/dist/server.mjs", "--raw"] },
      },
      [plugin("pdf", [name])],
    );
    process.execArgv.splice(0);
    process.argv[1] = "/fixture/runtime-a/mikiko.cjs";
    const first = bindOfficialPluginMcpRuntime(input);
    process.argv[1] = "/fixture/runtime-b/mikiko.cjs";
    const second = bindOfficialPluginMcpRuntime(first);
    expect(second.mcpServers[name]).toMatchObject({
      command: process.execPath,
      args: [
        "/fixture/runtime-b/mikiko.cjs",
        ZCODE_PLUGIN_HOST_COMMAND,
        "/fixture/pdf/dist/server.mjs",
        "--raw",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(first.mcpServers[name]).toMatchObject({
      args: [
        "/fixture/runtime-a/mikiko.cjs",
        ZCODE_PLUGIN_HOST_COMMAND,
        "/fixture/pdf/dist/server.mjs",
        "--raw",
      ],
    });
  });

  it("leaves HTTP, third-party, disabled and explicit user servers unchanged", () => {
    const http: McpServerConfig = { type: "http", url: "https://fixture.invalid/mcp" };
    const stdio: McpServerConfig = {
      type: "stdio",
      command: "custom-node",
      args: ["/fixture/user/server.mjs"],
    };
    const thirdParty = {
      ...plugin("pdf", ["plugin:pdf:pdf"]),
      marketplace: "third-party",
      id: "pdf@third-party",
    };
    const disabled = { ...plugin("disabled", ["plugin:disabled:server"]), enabled: false };
    const input = outcome(
      {
        "plugin:search:search": http,
        "plugin:pdf:pdf": stdio,
        "plugin:disabled:server": stdio,
        "user-explicit": stdio,
        "plugin:unlisted:server": stdio,
      },
      [plugin("search", ["plugin:search:search", "user-explicit"]), thirdParty, disabled],
    );
    expect(bindOfficialPluginMcpRuntime(input)).toBe(input);
  });

  it("Image Search 默认采用官方账号来源，产品自建域不改变目的地", () => {
    const existing = {
      type: "http" as const,
      url: "https://private-product.example/api/v1/mcp/server/image_search",
      timeoutMs: 90000,
    };
    expect(
      createImageSearchMcpConfig({
        existing,
        env: { MIKIKO_ENV: "production", MIKIKO_BASE_URL: "https://private-product.example" },
      }),
    ).toMatchObject({
      type: "http",
      url: "https://zcode.z.ai/api/v1/mcp/server/image_search",
      timeoutMs: 90000,
      auth: { type: "zcode_official", provider: "jwt_token" },
    });
    expect(
      createImageSearchMcpConfig({
        existing,
        env: { MIKIKO_ENV: "test", MIKIKO_BASE_URL: "http://127.0.0.1:3030" },
      }).url,
    ).toBe("http://127.0.0.1:3030/api/v1/mcp/server/image_search");
  });

  it("显式 custom Image Search adapter 不继承官方鉴权", () => {
    const existing = {
      type: "http" as const,
      url: "https://zcode.z.ai/api/v1/mcp/server/image_search",
      auth: { type: "zcode_official" as const, provider: "jwt_token" as const },
      official: {
        pluginId: "image-search@zcode-plugins-official",
        mcpKey: "image_search",
        source: "plugin" as const,
      },
    };
    const configured = createImageSearchMcpConfig({
      existing,
      backend: {
        kind: "custom",
        createMcpConfig: () => ({
          ...existing,
          url: "http://127.0.0.1:4040/custom-image",
          headers: { Authorization: "Bearer custom-fixture" },
        }),
      },
    });
    expect(configured).toEqual({
      type: "http",
      url: "http://127.0.0.1:4040/custom-image",
      headers: { Authorization: "Bearer custom-fixture" },
    });
    expect(existing.auth).toBeDefined();
  });

  it("Image Search runtime 按 metadata 精确重绑定旧自建 URL，不修改原对象", () => {
    const serverName = "plugin:image-search:image_search";
    const input = outcome(
      {
        [serverName]: {
          type: "http",
          url: "https://private-product.example/api/v1/mcp/server/image_search",
        },
      },
      [plugin("image-search", [serverName])],
    );
    const result = bindOfficialPluginMcpRuntime(input, { env: { MIKIKO_ENV: "production" } });
    expect(result.mcpServers[serverName]).toMatchObject({
      url: "https://zcode.z.ai/api/v1/mcp/server/image_search",
      auth: { type: "zcode_official", provider: "jwt_token" },
    });
    expect(input.mcpServers[serverName]).toMatchObject({
      url: "https://private-product.example/api/v1/mcp/server/image_search",
    });
  });

  it("真实 Mikiko Image Search manifest 被发现后采用账号 resolver，而非产品域", async () => {
    const root = await mkdtemp(join(tmpdir(), "mikiko-image-discovery-"));
    cleanups.push(root);
    const discovered = discoverNodePluginsSync({
      config: {
        dirs: [],
        enabled: true,
        enabledPlugins: {},
        extraKnownMarketplaces: {},
        options: {},
        suppressedBuiltins: [],
      },
      storageRoot: join(root, "plugins"),
      workingDirectory: root,
      officialPluginRoots: [fileURLToPath(new URL("../../image-search-plugin/", import.meta.url))],
      officialPluginsEnabledByDefault: new Set(["image-search@zcode-plugins-official"]),
      env: { MIKIKO_BASE_URL: "https://private-product.example" },
    });
    expect(discovered.diagnostics).toEqual([]);
    const metadata = discovered.plugins.find((entry) => entry.name === "image-search");
    expect(metadata?.manifestPath).toContain(".mikiko-plugin");
    const configured = bindOfficialPluginMcpRuntime(discovered, {
      env: { MIKIKO_ENV: "test", MIKIKO_BASE_URL: "http://127.0.0.1:3030" },
    });
    expect(configured.mcpServers["plugin:image-search:image_search"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:3030/api/v1/mcp/server/image_search",
      auth: { type: "zcode_official", provider: "jwt_token" },
      official: {
        pluginId: "image-search@zcode-plugins-official",
        mcpKey: "image_search",
        source: "plugin",
      },
    });
  });
});

function plugin(name: string, mcpServerNames: string[]): PluginMetadata {
  return {
    name,
    id: `${name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    enabled: true,
    mcpServerNames,
    declaredMcpServerNames: mcpServerNames,
    rootPath: `/fixture/${name}`,
    manifestPath: `/fixture/${name}/.mikiko-plugin/plugin.json`,
    dataPath: `/fixture/${name}/data`,
    source: "official",
    commandRootCount: 0,
    skillCount: 0,
    skillRootCount: 0,
    components: [],
    hookDetails: [],
  };
}

function outcome(
  mcpServers: Record<string, McpServerConfig>,
  plugins: PluginMetadata[],
): PluginLoadOutcome {
  return { mcpServers, plugins, commandRoots: [], diagnostics: [], hooks: {}, skillRoots: [] };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
