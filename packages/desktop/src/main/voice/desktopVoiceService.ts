/* eslint-disable max-lines -- 语音服务是模型文件/引擎 worker/会话三段生命周期的单一所有者（specs/desktop/voice-input.md），
   拆分会把同一份状态（downloading/engine/activeSession）散射到多个模块，扩大时序回归面。 */
/**
 * 语音服务（desktop main）—— specs/desktop/voice-input.md §4-6。
 * 模型文件下载/删除、引擎 worker 生命周期（懒加载/互斥/空闲卸载）、语音会话的唯一所有者。
 *
 * 可测性约束：本文件不 import electron —— worker 拉起（utilityProcess）与网络 fetch
 * 通过依赖注入；IPC 注册见 desktopVoiceIpc.ts。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_ENGINE_IDLE_UNLOAD_MS,
  VOICE_MODEL_MANIFESTS,
  VOICE_VAD_ARTIFACT,
  findVoiceModelManifest,
  type VoiceFinalResult,
  type VoiceModelFile,
  type VoiceModelInstallState,
  type VoiceSessionEvent,
  type VoiceSessionStartResult,
  type VoiceStateSnapshot,
} from "@zcode/shared";
import type { VoiceEngineEvent } from "./voiceEngineProtocol.js";

/** 会话事件投递目标（Electron WebContents 的最小面）。 */
export interface VoiceEventSink {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export interface VoiceEngineChildProcess {
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}

export interface DesktopVoiceServiceOptions {
  /** 模型根目录：`<root>/<modelId>/` 与 `<root>/_vad/`。 */
  modelsRootDir: string;
  /** utilityProcess worker 入口（out/main/voiceEngineWorker.cjs）。 */
  workerModulePath: string;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  spawnWorker?: (modulePath: string) => VoiceEngineChildProcess;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
  /** 测试注入：引擎加载超时（默认 120s，qwen3 大模型冷加载留足余量）。 */
  engineLoadTimeoutMs?: number;
  finishTimeoutMs?: number;
  /** 测试注入：空闲卸载延迟（生产固定用 VOICE_ENGINE_IDLE_UNLOAD_MS）。 */
  idleUnloadMs?: number;
}

interface ActiveVoiceSession {
  sessionId: string;
  modelId: string;
  sender: VoiceEventSink;
  startedAt: number;
  finishWaiter: {
    resolve: (value: { ok: true; result: VoiceFinalResult } | { ok: false; error: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
}

interface LoadedEngine {
  child: VoiceEngineChildProcess;
  modelId: string;
  /** 与 worker 侧 resetSeq 对齐的当前会话序号（stale feed/finish 双保险）。 */
  workerSeq: number;
  used: boolean;
}

const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 300;

export function createVoiceService(options: DesktopVoiceServiceOptions) {
  const { modelsRootDir, workerModulePath, logger } = options;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const spawnWorker =
    options.spawnWorker ??
    (() => {
      throw new Error("spawnWorker 未注入（仅可在 Electron main 内运行）");
    });

  const supported = !(process.platform === "win32" && process.arch === "arm64");
  const unsupportedReason = supported ? undefined : "sherpa-onnx 暂无 Windows arm64 预编译包";

  // ── 状态 ──
  const downloading = new Map<
    string,
    { receivedBytes: number; totalBytes: number; activeFile: string; promise: Promise<void> }
  >();
  const downloadErrors = new Map<string, string>();
  const lastUsedAt = new Map<string, number>();
  let engine: LoadedEngine | null = null;
  let engineLoadWaiter: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let activeSession: ActiveVoiceSession | null = null;
  let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;
  let downloadQueue: Promise<void> = Promise.resolve();
  const snapshotListeners = new Set<(snapshot: VoiceStateSnapshot) => void>();
  const sessionEventListeners = new Set<
    (sender: VoiceEventSink, sessionId: string, event: VoiceSessionEvent) => void
  >();

  const modelDir = (modelId: string) => join(modelsRootDir, modelId);
  const vadDir = () => join(modelsRootDir, "_vad");
  const vadModelPath = () => join(vadDir(), VOICE_VAD_ARTIFACT.path);

  async function fileReady(rootDir: string, file: VoiceModelFile): Promise<boolean> {
    try {
      const info = await stat(join(rootDir, file.path));
      return info.isFile() && info.size === file.sizeBytes;
    } catch {
      return false;
    }
  }

  async function computeInstallState(modelId: string): Promise<VoiceModelInstallState> {
    const inFlight = downloading.get(modelId);
    if (inFlight) {
      return {
        status: "downloading",
        receivedBytes: inFlight.receivedBytes,
        totalBytes: inFlight.totalBytes,
        activeFile: inFlight.activeFile,
      };
    }
    const error = downloadErrors.get(modelId);
    if (error) {
      return { status: "error", message: error };
    }
    const manifest = findVoiceModelManifest(modelId);
    if (!manifest) return { status: "not-installed" };
    let vadOk = true;
    if (manifest.requiresVad) {
      vadOk = await fileReady(vadDir(), VOICE_VAD_ARTIFACT);
    }
    for (const file of manifest.files) {
      if (!(await fileReady(modelDir(modelId), file))) {
        return { status: "not-installed" };
      }
    }
    return vadOk ? { status: "installed" } : { status: "not-installed" };
  }

  async function buildSnapshot(): Promise<VoiceStateSnapshot> {
    const models = [];
    for (const manifest of VOICE_MODEL_MANIFESTS) {
      models.push({
        modelId: manifest.id,
        install: await computeInstallState(manifest.id),
        ...(lastUsedAt.has(manifest.id) ? { lastUsedAt: lastUsedAt.get(manifest.id) } : {}),
      });
    }
    return {
      supported,
      ...(unsupportedReason ? { unsupportedReason } : {}),
      models,
      vadInstalled: await fileReady(vadDir(), VOICE_VAD_ARTIFACT),
      loadedModelId: engine?.modelId ?? null,
      activeSession: activeSession
        ? {
            sessionId: activeSession.sessionId,
            modelId: activeSession.modelId,
            startedAt: activeSession.startedAt,
          }
        : null,
    };
  }

  let snapshotEmitScheduled = false;
  function emitSnapshot(): void {
    if (snapshotEmitScheduled) return;
    snapshotEmitScheduled = true;
    queueMicrotask(async () => {
      snapshotEmitScheduled = false;
      const snapshot = await buildSnapshot();
      for (const listener of snapshotListeners) listener(snapshot);
    });
  }

  function emitSessionEvent(sessionId: string, event: VoiceSessionEvent): void {
    const session = activeSession;
    if (!session || session.sessionId !== sessionId) return;
    for (const listener of sessionEventListeners) {
      listener(session.sender, sessionId, event);
    }
  }

  // ── 下载 ──

  async function downloadArtifact(
    file: VoiceModelFile,
    rootDir: string,
    onFileProgress: (fileReceived: number) => void,
  ): Promise<void> {
    const destPath = join(rootDir, file.path);
    if (await fileReady(rootDir, file)) return;
    await mkdir(dirname(destPath), { recursive: true });
    // 残留 .part（上次中断）不可续传（sha 校验按整文件流设计），先清理。
    await rm(`${destPath}.part`, { force: true });

    const candidates = file.mirrorUrl ? [file.url, file.mirrorUrl] : [file.url];
    let lastError = "download failed";
    for (const url of candidates) {
      try {
        const response = await fetchFn(url, { redirect: "follow" });
        if (!response.ok || !response.body) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        const hash = createHash("sha256");
        const handle = await open(`${destPath}.part`, "wx");
        let received = 0;
        try {
          for await (const chunk of response.body) {
            const buffer = Buffer.from(chunk as ArrayBuffer);
            await handle.write(buffer);
            hash.update(buffer);
            received += buffer.byteLength;
            onFileProgress(received);
          }
        } finally {
          await handle.close();
        }
        if (received !== file.sizeBytes) {
          lastError = `size mismatch: ${received} != ${file.sizeBytes}`;
          await rm(`${destPath}.part`, { force: true });
          continue;
        }
        const digest = hash.digest("hex");
        if (digest !== file.sha256) {
          lastError = "sha256 mismatch";
          await rm(`${destPath}.part`, { force: true });
          continue;
        }
        await rename(`${destPath}.part`, destPath);
        return;
      } catch (error) {
        lastError = (error as Error)?.message ?? String(error);
        await rm(`${destPath}.part`, { force: true }).catch(() => undefined);
      }
    }
    throw new Error(`下载 ${file.path} 失败：${lastError}`);
  }

  function enqueueDownload(task: () => Promise<void>): Promise<void> {
    const next = downloadQueue.then(task, task);
    // 串行队列只保证互斥；失败向调用方传播，不阻塞后续任务。
    downloadQueue = next.catch(() => undefined);
    return next;
  }

  async function ensureModelInstalled(
    modelId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const manifest = findVoiceModelManifest(modelId);
    if (!manifest) return { ok: false, message: `未知模型：${modelId}` };
    const existing = downloading.get(modelId);
    if (existing) {
      await existing.promise.catch(() => undefined);
      return (await computeInstallState(modelId)).status === "installed"
        ? { ok: true }
        : { ok: false, message: downloadErrors.get(modelId) ?? "download failed" };
    }

    const artifacts: Array<{ file: VoiceModelFile; rootDir: string }> = [];
    if (manifest.requiresVad && !(await fileReady(vadDir(), VOICE_VAD_ARTIFACT))) {
      artifacts.push({ file: VOICE_VAD_ARTIFACT, rootDir: vadDir() });
    }
    for (const file of manifest.files) {
      if (!(await fileReady(modelDir(modelId), file))) {
        artifacts.push({ file, rootDir: modelDir(modelId) });
      }
    }
    if (artifacts.length === 0) {
      downloadErrors.delete(modelId);
      return { ok: true };
    }

    const totalBytes = artifacts.reduce((sum, item) => sum + item.file.sizeBytes, 0);
    const state = {
      receivedBytes: 0,
      totalBytes,
      activeFile: artifacts[0]!.file.path,
      promise: null as unknown as Promise<void>,
    };
    downloading.set(modelId, state);
    downloadErrors.delete(modelId);
    emitSnapshot();

    let lastEmit = 0;
    let baseBytes = 0;
    const promise = enqueueDownload(async () => {
      for (const item of artifacts) {
        state.activeFile = item.file.path;
        await downloadArtifact(item.file, item.rootDir, (fileReceived) => {
          state.receivedBytes = baseBytes + fileReceived;
          const timestamp = now();
          if (timestamp - lastEmit >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS) {
            lastEmit = timestamp;
            emitSnapshot();
          }
        });
        baseBytes += item.file.sizeBytes;
        state.receivedBytes = baseBytes;
        emitSnapshot();
      }
    })
      .then(() => {
        downloading.delete(modelId);
        emitSnapshot();
      })
      .catch((error: Error) => {
        downloading.delete(modelId);
        downloadErrors.set(modelId, error.message);
        logger.warn(`[voice] 模型 ${modelId} 下载失败：${error.message}`);
        emitSnapshot();
        throw error;
      });
    state.promise = promise;
    try {
      await promise;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  // ── 引擎 worker ──

  function clearIdleTimer(): void {
    if (idleUnloadTimer) {
      clearTimeout(idleUnloadTimer);
      idleUnloadTimer = null;
    }
  }

  function scheduleIdleUnload(): void {
    clearIdleTimer();
    idleUnloadTimer = setTimeout(() => {
      if (activeSession) return;
      void disposeEngine("idle");
    }, options.idleUnloadMs ?? VOICE_ENGINE_IDLE_UNLOAD_MS);
  }

  function disposeEngine(reason: string): void {
    if (engineLoadWaiter) {
      clearTimeout(engineLoadWaiter.timer);
      engineLoadWaiter.reject(new Error(`engine load interrupted: ${reason}`));
      engineLoadWaiter = null;
    }
    if (!engine) return;
    try {
      engine.child.postMessage({ type: "dispose" });
      engine.child.kill();
    } catch (error) {
      logger.warn(`[voice] 引擎 worker 退出异常：${(error as Error)?.message ?? error}`);
    }
    engine = null;
    logger.info(`[voice] 引擎 worker 已卸载（${reason}）`);
    emitSnapshot();
  }

  function handleEngineEvent(event: VoiceEngineEvent): void {
    // loaded 在引擎赋值前到达（engine 于 load 完成后才赋值），必须先于 engine 判空处理。
    if (event.type === "loaded") {
      if (engineLoadWaiter) {
        clearTimeout(engineLoadWaiter.timer);
        const waiter = engineLoadWaiter;
        engineLoadWaiter = null;
        waiter.resolve();
      }
      return;
    }
    const current = engine;
    if (!current) return;
    if (event.type === "error") {
      logger.error(`[voice] 引擎错误：${event.message}`);
      const waiter = activeSession?.finishWaiter;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, error: event.message });
      }
      if (activeSession) {
        emitSessionEvent(activeSession.sessionId, { kind: "error", message: event.message });
      }
      return;
    }
    if (!activeSession) return;
    if (event.type === "partial") {
      if (event.seq === current.workerSeq) {
        emitSessionEvent(activeSession.sessionId, { kind: "partial", text: event.text });
      }
      return;
    }
    if (event.type === "final") {
      const waiter = activeSession.finishWaiter;
      clearActiveSession();
      scheduleIdleUnload();
      if (waiter && event.seq === current.workerSeq) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: true, result: event.result });
      } else if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, error: "stale final" });
      }
    }
  }

  function clearActiveSession(): void {
    if (activeSession?.finishWaiter) {
      clearTimeout(activeSession.finishWaiter.timer);
    }
    activeSession = null;
    emitSnapshot();
  }

  async function ensureEngine(modelId: string): Promise<void> {
    if (engine && engine.modelId === modelId) {
      // 复用已加载引擎：重置 worker 会话状态（上一会话的流/分段残留）。
      if (engine.used) {
        engine.child.postMessage({ type: "reset" });
        engine.workerSeq += 1;
        engine.used = false;
      }
      return;
    }
    disposeEngine("switch-model");
    const manifest = findVoiceModelManifest(modelId);
    if (!manifest) throw new Error(`未知模型：${modelId}`);

    const child = spawnWorker(workerModulePath);
    let loadingChild = child;
    child.on("message", (message) => {
      handleEngineEvent(message as VoiceEngineEvent);
    });
    child.on("exit", () => {
      // 加载期退出：engine 尚未赋值，靠 loadingChild 判定，立即失败而非等满超时。
      const wasLoading = engineLoadWaiter && loadingChild === child;
      if (wasLoading) {
        clearTimeout(engineLoadWaiter.timer);
        engineLoadWaiter.reject(new Error("engine worker exited during load"));
        engineLoadWaiter = null;
      }
      loadingChild = null;
      const wasCurrent = engine?.child === child;
      if (wasCurrent) {
        engine = null;
        const waiter = activeSession?.finishWaiter;
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve({ ok: false, error: "engine exited" });
        }
        if (activeSession) {
          emitSessionEvent(activeSession.sessionId, {
            kind: "error",
            message: "voice engine exited",
          });
          clearActiveSession();
        }
        logger.warn("[voice] 引擎 worker 意外退出");
        emitSnapshot();
      }
    });

    const loadTimeout = options.engineLoadTimeoutMs ?? 120_000;
    await new Promise<void>((resolve, reject) => {
      engineLoadWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          engineLoadWaiter = null;
          reject(new Error("engine load timeout"));
        }, loadTimeout),
      };
      child.postMessage({
        type: "load",
        modelType: manifest.kind,
        modelDir: modelDir(modelId),
        ...(manifest.requiresVad ? { vadModelPath: vadModelPath() } : {}),
        numThreads: Math.max(1, Math.min(4, cpus().length - 2)),
      });
    }).catch((error: Error) => {
      disposeEngine("load-failed");
      throw error;
    });

    engine = { child, modelId, workerSeq: 1, used: false };
    logger.info(`[voice] 引擎已加载：${modelId}`);
    emitSnapshot();
  }

  // ── 公开操作 ──

  async function getState(): Promise<VoiceStateSnapshot> {
    return buildSnapshot();
  }

  async function downloadModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
    if (!findVoiceModelManifest(modelId)) return { ok: false, error: "model not found" };
    const result = await ensureModelInstalled(modelId);
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  }

  async function deleteModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
    if (!findVoiceModelManifest(modelId)) return { ok: false, error: "model not found" };
    if (downloading.has(modelId)) return { ok: false, error: "model is downloading" };
    if (activeSession?.modelId === modelId) return { ok: false, error: "model is in use" };
    if (engine?.modelId === modelId) {
      disposeEngine("delete-model");
    }
    await rm(modelDir(modelId), { recursive: true, force: true });
    downloadErrors.delete(modelId);
    emitSnapshot();
    return { ok: true };
  }

  async function startSession(
    sender: VoiceEventSink,
    input: { modelId?: string },
  ): Promise<VoiceSessionStartResult> {
    if (!supported) return { ok: false, error: "arch-unsupported", message: unsupportedReason };
    const modelId = input.modelId ?? DEFAULT_VOICE_MODEL_ID;
    const manifest = findVoiceModelManifest(modelId);
    if (!manifest) return { ok: false, error: "model-not-found" };
    if (activeSession) return { ok: false, error: "busy" };

    clearIdleTimer();
    const install = await ensureModelInstalled(modelId);
    if (!install.ok) return { ok: false, error: "download-failed", message: install.message };

    emitSessionEventForSender(sender, { kind: "engine-loading", modelId });
    try {
      await ensureEngine(modelId);
    } catch (error) {
      scheduleIdleUnload();
      return { ok: false, error: "engine-error", message: (error as Error).message };
    }

    const sessionId = `voice-${now().toString(36)}-${randomUUID().slice(0, 8)}`;
    activeSession = {
      sessionId,
      modelId,
      sender,
      startedAt: now(),
      finishWaiter: null,
    };
    lastUsedAt.set(modelId, now());
    if (engine) engine.used = true;
    emitSessionEvent(sessionId, { kind: "listening", modelId });
    emitSnapshot();
    return { ok: true, sessionId, modelId };
  }

  /** startSession 尚无会话 id，engine-loading 事件直接发给发起方。 */
  function emitSessionEventForSender(sender: VoiceEventSink, event: VoiceSessionEvent): void {
    for (const listener of sessionEventListeners) listener(sender, "", event);
  }

  function feedAudio(sessionId: string, samples: Int16Array): void {
    if (!activeSession || activeSession.sessionId !== sessionId || !engine) return;
    const floats = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      floats[index] = samples[index]! / 32768;
    }
    const seq = engine.workerSeq;
    engine.child.postMessage({ type: "feed", seq, samples: floats }, [floats.buffer]);
  }

  async function finishSession(
    sessionId: string,
  ): Promise<{ ok: true; result: VoiceFinalResult } | { ok: false; error: string }> {
    const session = activeSession;
    const currentEngine = engine;
    if (!session || session.sessionId !== sessionId || !currentEngine) {
      return { ok: false, error: "session not found" };
    }
    if (session.finishWaiter) {
      return { ok: false, error: "finish already pending" };
    }
    const seq = currentEngine.workerSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (activeSession?.finishWaiter?.resolve === resolve) {
          activeSession.finishWaiter = null;
        }
        if (activeSession?.sessionId === sessionId) {
          clearActiveSession();
          scheduleIdleUnload();
        }
        resolve({ ok: false, error: "finish timeout" });
      }, options.finishTimeoutMs ?? 30_000);
      session.finishWaiter = { resolve, timer };
      currentEngine.child.postMessage({ type: "finish", seq });
    });
  }

  function cancelSession(sessionId: string): void {
    if (!activeSession || activeSession.sessionId !== sessionId) return;
    const waiter = activeSession.finishWaiter;
    clearActiveSession();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: "canceled" });
    }
    if (engine) {
      // 丢弃在途残留：reset 递增 worker seq，旧 feed/finish 失效。
      engine.child.postMessage({ type: "reset" });
      engine.workerSeq += 1;
      engine.used = false;
    }
    scheduleIdleUnload();
  }

  function unloadEngine(): { ok: boolean; error?: string } {
    if (activeSession) return { ok: false, error: "session active" };
    clearIdleTimer();
    disposeEngine("manual");
    return { ok: true };
  }

  function dispose(): void {
    clearIdleTimer();
    if (activeSession?.finishWaiter) {
      clearTimeout(activeSession.finishWaiter.timer);
      activeSession.finishWaiter.resolve({ ok: false, error: "disposed" });
    }
    activeSession = null;
    disposeEngine("app-quit");
  }

  function onSnapshot(listener: (snapshot: VoiceStateSnapshot) => void): () => void {
    snapshotListeners.add(listener);
    return () => snapshotListeners.delete(listener);
  }

  function onSessionEvent(
    listener: (sender: VoiceEventSink, sessionId: string, event: VoiceSessionEvent) => void,
  ): () => void {
    sessionEventListeners.add(listener);
    return () => sessionEventListeners.delete(listener);
  }

  return {
    getState,
    downloadModel,
    deleteModel,
    startSession,
    feedAudio,
    finishSession,
    cancelSession,
    unloadEngine,
    dispose,
    onSnapshot,
    onSessionEvent,
  };
}

export type DesktopVoiceService = ReturnType<typeof createVoiceService>;

/** 模型目录中除 .part 残留外的文件数（供测试与诊断）。 */
export async function countModelFiles(rootDir: string): Promise<number> {
  try {
    const entries = await readdir(rootDir, { recursive: true });
    return entries.filter((entry) => !String(entry).endsWith(".part")).length;
  } catch {
    return 0;
  }
}
