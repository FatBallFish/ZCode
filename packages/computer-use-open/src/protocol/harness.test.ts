import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, expect } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const gateway = join(packageRoot, "dist/server.js");
export const fakeNative = fileURLToPath(new URL("../fixtures/fake-native.cjs", import.meta.url));
export const app = "dev.mikiko.computer-use.fixture";
type Audit = {
  kind: string;
  name?: string;
  args?: Record<string, unknown>;
  pid?: number;
  [key: string]: unknown;
};
type Fixture = Awaited<ReturnType<typeof start>>;
const fixtures: Fixture[] = [];
const directories: string[] = [];

beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", join(packageRoot, "tsconfig.json")],
    { timeout: 30_000 },
  );
}, 35_000);

export async function readAudit(path: string): Promise<Audit[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "mikiko-computer-protocol-"));
  directories.push(directory);
  const auditPath = join(directory, "audit.jsonl");
  await copyFile(fakeNative, join(directory, "mcp"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("MIKIKO_COMPUTER_USE_") &&
        !entry[0].startsWith("OPEN_COMPUTER_USE_") &&
        entry[0] !== "NODE_OPTIONS",
    ),
  );
  Object.assign(env, {
    MIKIKO_DATA_BASE_DIR: directory,
    MIKIKO_COMPUTER_USE_BINARY: process.execPath,
    MIKIKO_COMPUTER_USE_ALLOWED_APPS: JSON.stringify([app]),
    MIKIKO_COMPUTER_USE_CONFIG_FILE: join(directory, "native-config.json"),
    MIKIKO_FAKE_NATIVE_AUDIT: auditPath,
  });
  return { directory, auditPath, env };
}

export async function start(production = false, nativeEnv: Record<string, string> = {}) {
  const fixture = await environment();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--require",
      fakeNative,
      production ? join(packageRoot, "dist/production-server.js") : gateway,
    ],
    cwd: fixture.directory,
    env: { ...fixture.env, ...nativeEnv },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client(
    { name: "mikiko-computer-protocol-fixture", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  const value = { ...fixture, client, transport, stderr: () => stderr, gatewayPid: 0 };
  fixtures.push(value);
  try {
    await client.connect(transport, { timeout: 5000 });
  } finally {
    value.gatewayPid = transport.pid ?? 0;
  }
  return value;
}

export const context = (directory: string, extra: Record<string, unknown> = {}) => ({
  runtime_scope: "main",
  session_id: "fixture-session",
  turn_id: "turn-1",
  workspace_path: directory,
  client_mode: "desktop-continuous",
  delivery_kind: "desktop-continuous",
  ...extra,
});
export function call(
  fixture: Fixture,
  name: string,
  args: Record<string, unknown>,
  ctx?: Record<string, unknown>,
) {
  return fixture.client.callTool(
    { name, arguments: args, ...(ctx ? { _meta: { "com.zcode/request-context": ctx } } : {}) },
    { timeout: 5000 },
  );
}
export function denied(result: unknown, reason: string) {
  expect(result).toMatchObject({
    isError: true,
    content: [{ type: "text", text: expect.stringContaining(reason) }],
  });
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.client.close().catch(() => {});
    await fixture.transport.close().catch(() => {});
    // Only PIDs reported by this synthetic child are eligible for failure cleanup.
    for (const entry of await readAudit(fixture.auditPath)) {
      if (entry.kind === "native-start" && entry.pid && alive(entry.pid))
        process.kill(entry.pid, "SIGKILL");
    }
    if (fixture.gatewayPid && alive(fixture.gatewayPid))
      process.kill(fixture.gatewayPid, "SIGKILL");
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );
});
