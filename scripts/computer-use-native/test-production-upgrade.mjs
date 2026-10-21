#!/usr/bin/env node
/** Real signed App upgrade/identity boundaries; no AX, screenshot or user-app action. */
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { keepNativeAgent, waitForNativeSocketClosed } from "./native-test-client.mjs";
const run = promisify(execFile);
if (!process.argv[2]) throw new Error("Supply exact signed production App path.");
const app = resolve(process.argv[2]);
const proof = JSON.parse(await readFile(join(app, "../provenance.json"), "utf8"));
const socketPath = `/tmp/mikiko-computer-use-production-${process.getuid()}.sock`;
const directory = await mkdtemp(join(tmpdir(), "mikiko-native-upgrade-"));
const clone = join(directory, "Mikiko Computer Use.app");
const binary = (path) => join(path, "Contents/MacOS/mikiko-computer-use");
const doctor = async (path) =>
  JSON.parse((await run(binary(path), ["doctor", "--json"], { timeout: 20_000 })).stdout);
const clients = [];
let fake;
const keepers = [];
const keep = async (path) => {
  const keeper = await keepNativeAgent(binary(path));
  keepers.push(keeper);
  return keeper;
};
async function connect() {
  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");
  await new Promise((accept, reject) => {
    socket.once("connect", accept);
    socket.once("error", reject);
  });
  let pending,
    text = "";
  socket.on("data", (data) => {
    text += data;
    const i = text.indexOf("\n");
    if (i >= 0 && pending) {
      const callback = pending;
      pending = undefined;
      callback(JSON.parse(text.slice(0, i)));
      text = text.slice(i + 1);
    }
  });
  const client = {
    close: () => socket.destroy(),
    request: (value) =>
      new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("App-agent response deadline")), 6000);
        pending = (result) => {
          clearTimeout(timer);
          accept(result);
        };
        socket.write(JSON.stringify(value) + "\n");
      }),
  };
  clients.push(client);
  return client;
}
async function info() {
  const client = await connect();
  try {
    return await client.request({ kind: "agentInfo" });
  } finally {
    client.close();
  }
}
try {
  await keep(app);
  assert.equal((await doctor(app)).appPath, app);
  await cp(app, clone, { recursive: true });
  await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-R",
    '=identifier "dev.mikiko.computer-use" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    clone,
  ]);
  const owner = await connect();
  await owner.request({
    kind: "mcp",
    line: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_app_state",
        arguments: { app: "dev.mikiko.nonexistent-upgrade-fixture" },
      },
    }),
    environment: {},
  });
  await assert.rejects(doctor(clone), (error) => error.code === 1);
  assert.equal((await info()).bundleURL, app, "busy upgrade must preserve original owner");
  await owner.request({
    kind: "mcp",
    line: JSON.stringify({ jsonrpc: "2.0", method: "notifications/turn-ended" }),
    environment: {},
  });
  owner.close();
  assert.equal(
    (await doctor(clone)).appPath,
    clone,
    "trusted idle same-team App can migrate paths",
  );
  await keep(clone);
  assert.equal(
    (await doctor(app)).appPath,
    app,
    "new signed installation reclaims idle compatible helper",
  );
  await keep(app);
  const owned = await connect();
  const verified = await owned.request({ kind: "agentInfo" });
  assert.equal(verified.bundleURL, app);
  assert.equal(verified.buildIdentifier, proof.buildInputSha256);
  assert.equal(verified.controlBusy, false);
  assert.equal((await owned.request({ kind: "terminate" })).ok, true);
  owned.close();
  for (let i = 0; i < 80; i++) {
    let alive = true;
    try {
      await info();
    } catch {
      alive = false;
    }
    if (!alive) break;
    await delay(25);
  }
  const fakeRequests = [];
  fake = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (data) => {
      for (const line of data.trim().split("\n")) {
        const request = JSON.parse(line);
        fakeRequests.push(request.kind);
        socket.write(
          JSON.stringify({
            bundleIdentifier: "dev.mikiko.computer-use",
            bundleURL: app,
            buildIdentifier: proof.buildInputSha256,
            controlBusy: false,
            processStartTime: Date.now() / 1000,
          }) + "\n",
        );
      }
    });
  });
  await new Promise((accept, reject) => {
    fake.once("error", reject);
    fake.listen(socketPath, accept);
  });
  await assert.rejects(doctor(app), (error) => error.code === 1);
  await assert.rejects(
    run(binary(app), ["restart-agent", "--json"], { timeout: 10000 }),
    (error) => JSON.parse(error.stdout).error.code === "identity_mismatch",
  );
  assert.equal(
    fakeRequests.includes("terminate"),
    false,
    "untrusted peer cannot trigger an unauthenticated terminate",
  );
  await new Promise((accept, reject) => fake.close((error) => (error ? reject(error) : accept())));
  fake = undefined;
  assert.equal((await doctor(app)).appPath, app);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "busy-upgrade-preserves-owner",
        "same-team-idle-path-upgrade",
        "return-to-new-installation",
        "untrusted-same-uid-peer-refused",
        "untrusted-restart-identity-code",
        "untrusted-peer-never-terminated",
        "recovery-after-untrusted-peer",
      ],
      nativeActionsInvoked: false,
      buildIdentifier: proof.buildInputSha256,
    }),
  );
} finally {
  for (const client of clients) client.close();
  for (const keeper of keepers) await keeper.close();
  if (fake) await new Promise((accept) => fake.close(accept));
  await waitForNativeSocketClosed();
  await rm(directory, { recursive: true, force: true });
}
