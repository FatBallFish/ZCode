import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VOICE_VAD_ARTIFACT, findVoiceModelManifest } from "@zcode/shared";
import { createVoiceService } from "../../src/main/voice/desktopVoiceService.js";

/** 可编程假 worker：记录 main 下发的命令，测试侧注入 worker 事件。
 * autoLoad=true 时收到 load 命令自动回 loaded 握手（真实 worker 行为）；
 * manualLoad 场景（加载期错误/退出）由测试自行注入事件。 */
class FakeWorker {
  commands: Array<Record<string, unknown> & { type: string }> = [];
  killed = false;
  autoLoad = true;
  private listeners = new Map<string, Array<(arg: unknown) => void>>();

  postMessage(message: unknown): void {
    const command = message as Record<string, unknown> & { type: string };
    this.commands.push(command);
    if (command.type === "load" && this.autoLoad) {
      queueMicrotask(() => this.emit("message", { type: "loaded", modelType: command.modelType }));
    }
  }
  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
  on(event: string, listener: (arg: unknown) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, arg: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }
  lastCommand(type: string): (Record<string, unknown> & { type: string }) | undefined {
    for (let index = this.commands.length - 1; index >= 0; index -= 1) {
      if (this.commands[index]!.type === type) return this.commands[index];
    }
    return undefined;
  }
}

interface Harness {
  service: ReturnType<typeof createVoiceService>;
  workers: FakeWorker[];
  modelsRoot: string;
  sessionEvents: Array<{ sessionId: string; event: Record<string, unknown> }>;
  sender: { send(channel: string, payload: unknown): void; isDestroyed(): boolean };
  dispose(): Promise<void>;
}

async function createHarness(options?: {
  fetchFn?: typeof globalThis.fetch;
  idleUnloadMs?: number;
  engineLoadTimeoutMs?: number;
  manualLoad?: boolean;
}): Promise<Harness> {
  const modelsRoot = await mkdtemp(join(tmpdir(), "zcode-voice-test-"));
  const workers: FakeWorker[] = [];
  const manualLoad = options?.manualLoad === true;
  const service = createVoiceService({
    modelsRootDir: modelsRoot,
    workerModulePath: "/virtual/voiceEngineWorker.cjs",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    spawnWorker: () => {
      const worker = new FakeWorker();
      worker.autoLoad = !manualLoad;
      workers.push(worker);
      return worker;
    },
    ...(options?.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options?.idleUnloadMs ? { idleUnloadMs: options.idleUnloadMs } : {}),
    ...(options?.engineLoadTimeoutMs ? { engineLoadTimeoutMs: options.engineLoadTimeoutMs } : {}),
  });
  const sessionEvents: Harness["sessionEvents"] = [];
  const sender: Harness["sender"] = {
    send: () => {},
    isDestroyed: () => false,
  };
  service.onSessionEvent((_target, sessionId, event) => {
    sessionEvents.push({ sessionId, event: event as unknown as Record<string, unknown> });
  });
  return {
    service,
    workers,
    modelsRoot,
    sessionEvents,
    sender,
    dispose: async () => {
      service.dispose();
      await rm(modelsRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** 预置指定模型的全部文件（字节数精确匹配即视为已安装；sha 仅下载时校验）。 */
async function materializeModel(modelsRoot: string, modelId: string): Promise<void> {
  const manifest = findVoiceModelManifest(modelId);
  assert.ok(manifest, `manifest 缺失：${modelId}`);
  for (const file of manifest.files) {
    const dest = join(modelsRoot, modelId, file.path);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, Buffer.alloc(file.sizeBytes));
  }
  if (manifest.requiresVad) {
    const vadPath = join(modelsRoot, "_vad", VOICE_VAD_ARTIFACT.path);
    await mkdir(join(vadPath, ".."), { recursive: true });
    await writeFile(vadPath, Buffer.alloc(VOICE_VAD_ARTIFACT.sizeBytes));
  }
}

/** 驱动假 worker 完成加载握手。 */
function workerLoaded(worker: FakeWorker): void {
  const loadCommand = worker.lastCommand("load");
  assert.ok(loadCommand, "worker 未收到 load 命令");
  worker.emit("message", { type: "loaded", modelType: loadCommand.modelType });
}

/** 驱动假 worker 结束会话（finish 命令回 final 事件）。 */
async function driveFinish(harness: Harness, sessionId: string, text: string): Promise<void> {
  const worker = harness.workers[harness.workers.length - 1]!;
  const finishPromise = harness.service.finishSession(sessionId);
  const finishCommand = worker.lastCommand("finish");
  assert.ok(finishCommand, "worker 未收到 finish 命令");
  worker.emit("message", {
    type: "final",
    seq: finishCommand.seq,
    result: { text, durationMs: 1, segments: [] },
  });
  await finishPromise;
}

test("会话全流程：已安装模型 → 引擎加载 → feed/partial → finish/final", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");

  const start = await harness.service.startSession(harness.sender, {});
  assert.equal(start.ok, true);
  if (!start.ok) return;
  const worker = harness.workers[0]!;
  workerLoaded(worker);

  const snapshot1 = await harness.service.getState();
  assert.equal(snapshot1.loadedModelId, "sensevoice-int8");
  assert.equal(snapshot1.activeSession?.sessionId, start.sessionId);

  harness.service.feedAudio(start.sessionId, new Int16Array([0, 16384, -16384]));
  const feed = worker.lastCommand("feed");
  assert.ok(feed);
  const samples = feed.samples as Float32Array;
  assert.equal(samples.length, 3);
  assert.ok(Math.abs(samples[1]! - 0.5) < 1e-6);

  worker.emit("message", { type: "partial", seq: feed.seq, text: "你好" });
  const partialEvent = harness.sessionEvents.find(
    (entry) => (entry.event as { kind?: string }).kind === "partial",
  );
  assert.ok(partialEvent);
  assert.equal(partialEvent.sessionId, start.sessionId);
  assert.equal((partialEvent.event as { text?: string }).text, "你好");

  await driveFinish(harness, start.sessionId, "你好，世界。");
  const snapshot2 = await harness.service.getState();
  assert.equal(snapshot2.activeSession, null);
  assert.equal(snapshot2.loadedModelId, "sensevoice-int8");
});

test("活动会话互斥：第二个 start 返回 busy", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const first = await harness.service.startSession(harness.sender, {});
  assert.equal(first.ok, true);
  const second = await harness.service.startSession(harness.sender, {});
  assert.deepEqual(second, { ok: false, error: "busy" });
});

test("取消会话：reset 递增 worker seq，旧 feed 丢弃", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const start = await harness.service.startSession(harness.sender, {});
  if (!start.ok) assert.fail("start failed");
  const worker = harness.workers[0]!;
  workerLoaded(worker);
  harness.service.cancelSession(start.sessionId);

  assert.ok(worker.lastCommand("reset"));
  // 取消后再 feed 旧 sessionId：直接丢弃，不产生新命令。
  const commandCount = worker.commands.length;
  harness.service.feedAudio(start.sessionId, new Int16Array(4));
  assert.equal(worker.commands.length, commandCount);
  const snapshot = await harness.service.getState();
  assert.equal(snapshot.activeSession, null);
});

test("下载校验失败：sha 不匹配 → start 返回 download-failed 且状态置 error", async (t) => {
  const harness = await createHarness({
    fetchFn: (async () => new Response(Buffer.alloc(8))) as unknown as typeof globalThis.fetch,
  });
  t.after(() => harness.dispose());
  const start = await harness.service.startSession(harness.sender, { modelId: "sensevoice-int8" });
  assert.equal(start.ok, false);
  if (!start.ok) {
    assert.equal(start.error, "download-failed");
  }
  const snapshot = await harness.service.getState();
  const model = snapshot.models.find((entry) => entry.modelId === "sensevoice-int8");
  assert.equal(model?.install.status, "error");
  // 未触达引擎：无 worker 拉起。
  assert.equal(harness.workers.length, 0);
});

test("空闲卸载：会话结束到达 idle 延迟后 worker 退出", async (t) => {
  const harness = await createHarness({ idleUnloadMs: 30 });
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const start = await harness.service.startSession(harness.sender, {});
  if (!start.ok) assert.fail("start failed");
  const worker = harness.workers[0]!;
  workerLoaded(worker);
  await driveFinish(harness, start.sessionId, "ok");
  assert.equal(worker.killed, false);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(worker.killed, true);
  const snapshot = await harness.service.getState();
  assert.equal(snapshot.loadedModelId, null);
});

test("切换模型：finish 后 start 另一模型会先杀旧 worker", async (t) => {
  const harness = await createHarness({ idleUnloadMs: 60_000 });
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  await materializeModel(harness.modelsRoot, "zipformer-bilingual-int8");

  const first = await harness.service.startSession(harness.sender, { modelId: "sensevoice-int8" });
  if (!first.ok) assert.fail("first start failed");
  const firstWorker = harness.workers[0]!;
  workerLoaded(firstWorker);
  await driveFinish(harness, first.sessionId, "ok");

  const second = await harness.service.startSession(harness.sender, {
    modelId: "zipformer-bilingual-int8",
  });
  assert.equal(second.ok, true);
  assert.equal(firstWorker.killed, true);
  const secondWorker = harness.workers[1]!;
  const load = secondWorker.lastCommand("load");
  assert.equal(load?.modelType, "zipformer-streaming");
  assert.equal(load?.vadModelPath, undefined);
});

test("删除模型：已加载引擎先卸载，目录被清空", async (t) => {
  const harness = await createHarness({ idleUnloadMs: 60_000 });
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const start = await harness.service.startSession(harness.sender, {});
  if (!start.ok) assert.fail("start failed");
  const worker = harness.workers[0]!;
  workerLoaded(worker);
  await driveFinish(harness, start.sessionId, "ok");

  const result = await harness.service.deleteModel("sensevoice-int8");
  assert.equal(result.ok, true);
  assert.equal(worker.killed, true);
  await assert.rejects(stat(join(harness.modelsRoot, "sensevoice-int8")));
});

test("未知模型：start 返回 model-not-found", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  const start = await harness.service.startSession(harness.sender, { modelId: "not-a-model" });
  assert.deepEqual(start, { ok: false, error: "model-not-found" });
});

test("加载期 worker 报错：立即 engine-error 且 worker 被 kill（无孤儿进程）", async (t) => {
  const harness = await createHarness({ engineLoadTimeoutMs: 60_000, manualLoad: true });
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const startPromise = harness.service.startSession(harness.sender, {});
  // 等待 load 命令下发后注入 worker 错误（不等 loaded）。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const worker = harness.workers[0]!;
  assert.ok(worker.lastCommand("load"));
  worker.emit("message", { type: "error", message: "boom" });
  const start = await startPromise;
  assert.equal(start.ok, false);
  if (!start.ok) {
    assert.equal(start.error, "engine-error");
    assert.match(start.message ?? "", /boom/);
  }
  assert.equal(worker.killed, true);
});

test("并发 startSession：串行化后第二个返回 busy（无双 worker）", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const [first, second] = await Promise.all([
    harness.service.startSession(harness.sender, {}),
    harness.service.startSession(harness.sender, {}),
  ]);
  const oks = [first, second].filter((result) => result.ok).length;
  assert.equal(oks, 1);
  assert.equal(harness.workers.length, 1);
  assert.deepEqual(
    [first, second].find((result) => !result.ok),
    { ok: false, error: "busy" },
  );
});

test("会话中引擎错误：会话清理并可重新 start（不悬置 busy）", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  await materializeModel(harness.modelsRoot, "sensevoice-int8");
  const first = await harness.service.startSession(harness.sender, {});
  if (!first.ok) assert.fail("first start failed");
  const worker = harness.workers[0]!;
  harness.service.feedAudio(first.sessionId, new Int16Array(1600));

  worker.emit("message", { type: "error", message: "decode failed" });
  const errorEvents = harness.sessionEvents.filter(
    (entry) => (entry.event as { kind?: string }).kind === "error",
  );
  assert.equal(errorEvents.length, 1);
  let snapshot = await harness.service.getState();
  assert.equal(snapshot.activeSession, null);
  // worker 已复位（reset 命令），引擎保留可复用。
  assert.ok(worker.lastCommand("reset"));
  assert.equal(snapshot.loadedModelId, "sensevoice-int8");

  const second = await harness.service.startSession(harness.sender, {});
  assert.equal(second.ok, true);
  snapshot = await harness.service.getState();
  assert.ok(snapshot.activeSession);
});
