import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import type { ReleaseManifest } from "../contracts.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createUpdateDaemonHandoff, runProxyStdio } from "./contract.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mikiko-daemon-contract-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function releasePair() {
  const layout = resolveServerLayout(join(await fixture(), "server"));
  const releases = new ReleaseManager(layout);
  await releases.ensure();
  const previous: ReleaseManifest = {
    version: "3.16.2",
    releaseId: "previous",
    releaseDir: join(layout.releasesDir, "previous"),
  };
  const target: ReleaseManifest = {
    version: "3.16.2",
    releaseId: "target",
    releaseDir: join(layout.releasesDir, "target"),
  };
  for (const release of [previous, target]) {
    await mkdir(release.releaseDir);
    await releases.writePending(release);
    await releases.applyPending();
  }
  return { layout, releases, previous, target };
}

it("只有实际三个运行身份收敛才成功，且遵守 stop → start → identity 顺序", async () => {
  const { layout, releases, previous, target } = await releasePair();
  const events: string[] = [];
  await createUpdateDaemonHandoff({
    stopDaemon: async () => {
      events.push("stop");
    },
    startDaemon: async (_layout, release) => {
      events.push(`start:${release.releaseId}`);
    },
    readRuntimeIdentity: async () => {
      events.push("identity");
      return {
        supervisorVersion: target.version,
        supervisorReleaseId: target.releaseId,
        activeReleaseVersion: target.version,
        activeReleaseId: target.releaseId,
        coreVersion: target.version,
        coreReleaseId: target.releaseId,
      };
    },
  }).converge({ layout, previous, target });
  expect(events).toEqual(["stop", "start:target", "identity"]);
  expect(await releases.readCurrent()).toEqual(target);
});

it("同版本但 Supervisor 构建身份不一致时，先恢复真实指针再重启 previous", async () => {
  const { layout, releases, previous, target } = await releasePair();
  const events: string[] = [];
  await expect(
    createUpdateDaemonHandoff({
      stopDaemon: async () => {
        events.push("stop");
      },
      startDaemon: async (_layout, release) => {
        expect(await releases.readCurrent()).toEqual(release);
        events.push(`start:${release.releaseId}`);
      },
      readRuntimeIdentity: async () => ({
        supervisorVersion: target.version,
        supervisorReleaseId: previous.releaseId,
        activeReleaseVersion: target.version,
        activeReleaseId: target.releaseId,
        coreVersion: target.version,
        coreReleaseId: target.releaseId,
      }),
    }).converge({ layout, previous, target }),
  ).rejects.toThrow("previous release was restored");
  expect(events).toEqual(["stop", "start:target", "stop", "start:previous"]);
  expect(await releases.readCurrent()).toEqual(previous);
});

it("ready daemon 的 loopback stdio 桥逐字节透明并保持调用方 output 打开", async () => {
  const layout = resolveServerLayout(join(await fixture(), "server"));
  const sockets = new Set<Socket>();
  const echo = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    await new Promise<void>((resolve, reject) => {
      echo.once("error", reject);
      echo.listen(0, "127.0.0.1", resolve);
    });
    const address = echo.address();
    if (!address || typeof address === "string") throw new Error("missing echo port");
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(
      layout.statusFile,
      JSON.stringify({
        protocolVersion: 1,
        state: "ready",
        pid: process.pid,
        port: address.port,
        host: "127.0.0.1",
        version: "3.16.2",
        generation: 1,
        startedAt: Date.now(),
        lastExitReason: null,
        serviceRegistered: false,
        runningTaskCount: 0,
        crashBudget: { crashCount: 0, nextRestartDelayMs: 1000, exhausted: false },
        updatedAt: Date.now(),
      }),
    );
    const received: Buffer[] = [];
    output.on("data", (chunk) => received.push(Buffer.from(chunk)));
    const payload = Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]);
    const forwarding = runProxyStdio({ layout, input, output });
    input.end(payload);
    await forwarding;
    expect(Buffer.concat(received)).toEqual(payload);
    expect(output.writableEnded).toBe(false);
  } finally {
    input.destroy();
    output.destroy();
    for (const socket of sockets) socket.destroy();
    if (echo.listening) await new Promise<void>((resolve) => echo.close(() => resolve()));
  }
});

it("缺失 daemon 状态时拒绝且不写入通道字节", async () => {
  const layout = resolveServerLayout(join(await fixture(), "server"));
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Buffer[] = [];
  output.on("data", (chunk) => received.push(Buffer.from(chunk)));
  try {
    await expect(runProxyStdio({ layout, input, output })).rejects.toMatchObject({
      name: "ProxyStdioError",
      code: "daemon-not-ready",
    });
    expect(received).toEqual([]);
    expect(output.writableEnded).toBe(false);
  } finally {
    input.destroy();
    output.destroy();
  }
});
