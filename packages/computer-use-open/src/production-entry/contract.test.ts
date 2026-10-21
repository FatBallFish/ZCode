import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const fixture = vi.hoisted(() => ({
  controller: { close: vi.fn(async () => {}) },
  handle: { close: vi.fn(async () => {}) },
  serve: vi.fn(),
  createServer: vi.fn(() => ({ name: "fixture" })),
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: fixture.serve }));
vi.mock("../production.js", () => ({
  createProductionComputerUseController: () => fixture.controller,
}));
vi.mock("../mcp-server.js", () => ({ createPreviewServer: fixture.createServer }));

const originalTitle = process.title;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.serve.mockReturnValue(fixture.handle);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.title = originalTitle;
});

it("exports the plugin-host main without starting MCP as an import side effect", async () => {
  // 宿主先import再验证main；副作用启动会造成短暂发现成功，随后宿主因缺main退出。
  vi.spyOn(process, "once").mockReturnValue(process);
  vi.spyOn(process.stdin, "once").mockReturnValue(process.stdin);
  const entry = await import("../production-server.js");
  expect(fixture.serve).not.toHaveBeenCalled();
  expect(entry).toHaveProperty("main", expect.any(Function));
});

it("starts through main and disposes once when EOF and signals converge", async () => {
  const handlers: Array<() => void> = [];
  vi.spyOn(process, "once").mockImplementation((_event, handler) => {
    handlers.push(handler as () => void);
    return process;
  });
  vi.spyOn(process.stdin, "once").mockImplementation((_event, handler) => {
    handlers.push(handler as () => void);
    return process.stdin;
  });
  const entry = await import("../production-server.js");
  expect(entry).toHaveProperty("main", expect.any(Function));
  await (entry as { main(): Promise<void> }).main();
  expect(fixture.serve).toHaveBeenCalledOnce();
  const create = fixture.serve.mock.calls[0]![0] as () => unknown;
  create();
  expect(fixture.createServer).toHaveBeenCalledWith(fixture.controller, true);
  expect(handlers).toHaveLength(3);
  for (const handler of handlers) handler();
  await vi.waitFor(() => expect(fixture.handle.close).toHaveBeenCalledOnce());
  expect(fixture.controller.close).toHaveBeenCalledOnce();
});

it("starts the standalone entry through a symlink path with the real modern MCP handshake", async () => {
  const root = await mkdtemp(join(tmpdir(), "mikiko-cua-entry-"));
  const client = new Client(
    { name: "mikiko-entry-test", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  let transport: StdioClientTransport | undefined;
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("../production-server.ts", import.meta.url))],
      outfile: join(root, "entry.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    const alias = join(root, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(alias, "entry.mjs")],
      stderr: "pipe",
    });
    await client.connect(transport, { timeout: 5000 });
    expect(client.getServerVersion()?.name).toBe("mikiko-computer-use");
  } finally {
    await client.close();
    await transport?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
