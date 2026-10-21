#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(
  new URL("../../packages/computer-use-open/package.json", import.meta.url),
);
const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/client")));
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio"))
);
if (!process.argv[2]) throw new Error("Supply the staged standalone production-server.mjs.");
const directory = await mkdtemp(join(tmpdir(), "mikiko-packaged-gateway-"));
let client;
try {
  const entry = join(directory, "production-server.mjs");
  await copyFile(resolve(process.argv[2]), entry);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== "NODE_PATH" && key !== "NODE_OPTIONS" && !key.startsWith("MIKIKO_COMPUTER_USE_"),
    ),
  );
  environment.MIKIKO_COMPUTER_USE_BINARY = resolve(process.argv[3] ?? "");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: directory,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  client = new Client(
    { name: "mikiko-packaged-gateway-smoke", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport, { timeout: 5000 });
  const tools = (await client.listTools()).tools;
  for (const name of ["list_apps", "get_app_state", "click", "stop"])
    assert.ok(tools.some((tool) => tool.name === name));
  assert.ok(
    tools.find((tool) => tool.name === "drag")?.description.includes("Moves the real system mouse"),
    "Packaged tool catalog lost visible-pointer contract",
  );
  const refused = await client.callTool({ name: "list_apps", arguments: {} }, undefined, {
    timeout: 5000,
  });
  assert.equal(refused.isError, true, "standalone gateway still requires trusted host context");
  const pid = transport.pid;
  await client.close();
  client = undefined;
  if (pid)
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === "ESRCH",
    );
  assert.equal(stderr, "");
  console.log(
    JSON.stringify({
      passed: true,
      sdk: 2,
      standaloneOutsideRepository: true,
      nodeModulesPresent: false,
      tools: tools.map((tool) => tool.name),
      missingContextRefused: true,
      EOFProcessClosed: true,
      nativeActionsInvoked: false,
    }),
  );
} finally {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
}
