#!/usr/bin/env node
/** Only this exact explicitly supplied production App is contacted; no user-app actions. */
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { keepNativeAgent, waitForNativeSocketClosed } from "./native-test-client.mjs";
const run = promisify(execFile);
const app = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !app.endsWith("/Mikiko Computer Use.app"))
  throw new Error("Supply the exact production App path.");
const proof = JSON.parse(await readFile(join(app, "../provenance.json"), "utf8"));
const binary = join(app, "Contents/MacOS/mikiko-computer-use");
const socketPath = `/tmp/mikiko-computer-use-production-${process.getuid()}.sock`;
const clients = [];
async function connect() {
  const socket = createConnection(socketPath);
  let pending;
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    text += data;
    const index = text.indexOf("\n");
    if (index >= 0 && pending) {
      const accept = pending;
      pending = undefined;
      const line = text.slice(0, index);
      text = text.slice(index + 1);
      accept(JSON.parse(line));
    }
  });
  await new Promise((accept, reject) => {
    socket.once("connect", accept);
    socket.once("error", reject);
  });
  const client = {
    close: () => socket.destroy(),
    request: async (value) => {
      assert.equal(pending, undefined);
      return await new Promise((accept, reject) => {
        const timeout = setTimeout(() => {
          pending = undefined;
          reject(new Error("App-agent response deadline"));
        }, 6000);
        pending = (result) => {
          clearTimeout(timeout);
          accept(result);
        };
        socket.write(JSON.stringify(value) + "\n");
      });
    },
  };
  clients.push(client);
  return client;
}
const mcp = (id, method, params = {}) => ({
  kind: "mcp",
  line: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  environment: {},
});
const call = (id) =>
  mcp(id, "tools/call", {
    name: "get_app_state",
    arguments: { app: "dev.mikiko.nonexistent-lease-fixture", disableDiff: true },
  });
const decoded = (result) => (result.response ? JSON.parse(result.response) : null);
const isBusy = (result) => JSON.stringify(result).includes("Mikiko Computer Use busy");
const keeper = await keepNativeAgent(binary);
try {
  const doctor = JSON.parse((await run(binary, ["doctor", "--json"], { timeout: 20000 })).stdout);
  assert.equal(doctor.appAgent, true);
  assert.equal(doctor.grantOwnerBundleId, "dev.mikiko.computer-use");
  assert.equal(doctor.appPath, app);
  assert.equal(doctor.buildIdentifier, proof.buildInputSha256);
  const a = await connect(),
    b = await connect(),
    observer = await connect();
  const info = await observer.request({ kind: "agentInfo" });
  assert.equal(info.bundleURL, app);
  assert.equal(info.controlBusy, false);
  assert.equal(decoded(await b.request(mcp(1, "tools/list"))).result.tools.length, 11);
  assert.equal((await observer.request({ kind: "agentInfo" })).controlBusy, false);
  const first = await a.request(call(2));
  assert.equal(isBusy(first), false);
  assert.ok(decoded(first));
  assert.equal((await observer.request({ kind: "agentInfo" })).controlBusy, true);
  assert.equal(isBusy(await b.request(call(3))), true);
  const readOnly = await connect();
  const permissionEnvelope = await readOnly.request({
    kind: "cli",
    arguments: ["doctor", "--json"],
    environment: {},
  });
  assert.equal(JSON.parse(permissionEnvelope.stdout).appAgent, true);
  readOnly.close();
  assert.equal(isBusy(await b.request(call(4))), true);
  await assert.rejects(
    run(binary, ["restart-agent", "--json"], { timeout: 10000 }),
    (error) => JSON.parse(error.stdout).error.code === "controller_busy",
  );
  await b.request(mcp(undefined, "notifications/turn-ended"));
  assert.equal(isBusy(await b.request(call(5))), true, "non-owner turn end cannot release A");
  await a.request(mcp(undefined, "notifications/turn-ended"));
  assert.equal(isBusy(await b.request(call(6))), false);
  b.close();
  let released = false;
  for (let count = 0; count < 40; count++) {
    if (!(await observer.request({ kind: "agentInfo" })).controlBusy) {
      released = true;
      break;
    }
    await delay(25);
  }
  assert.equal(released, true, "EOF releases after synchronous work completes");
  assert.equal(isBusy(await a.request(call(7))), false);
  await a.request(mcp(undefined, "notifications/cancelled"));
  assert.equal((await observer.request({ kind: "agentInfo" })).controlBusy, false);
  const restarted = JSON.parse(
    (await run(binary, ["restart-agent", "--json"], { timeout: 20_000 })).stdout,
  );
  assert.equal(restarted.restarted, true);
  assert.equal(restarted.permissions.appPath, app);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "exact-agent-identity",
        "discovery-without-lease",
        "cross-connection-busy",
        "doctor-read-only",
        "read-only-close-preserves-owner",
        "busy-restart-refused",
        "non-owner-end-refused",
        "turn-end-release",
        "EOF-release",
        "cancel-release",
        "idle-restart",
      ],
      permissions: doctor,
      nativeActionsInvoked: false,
    }),
  );
} finally {
  for (const client of clients) client.close();
  await keeper.close();
  await waitForNativeSocketClosed();
}
