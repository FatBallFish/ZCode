import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGenUiStateStorage } from "./stateStorage.js";

vi.mock("chokidar", () => ({ watch: vi.fn() }));

class ControlledWatcher extends EventEmitter {
  constructor(
    readonly options: Pick<FSWatcher["options"], "usePolling" | "interval" | "binaryInterval">,
  ) {
    super();
  }
  close = vi.fn(async () => {});
}
const watchers: ControlledWatcher[] = [];
let created = Promise.withResolvers<ControlledWatcher>();
const cleanup: Array<() => void | Promise<void>> = [];
const target = { workspacePath: "/workspace", sessionId: "task", path: "/workspace/chart.html" };
let effectiveOverride: Partial<ControlledWatcher["options"]> = {};
const effectiveOptions = (options?: Parameters<typeof watch>[1]) => ({
  usePolling: options?.usePolling ?? false,
  interval: options?.interval ?? 100,
  binaryInterval: options?.binaryInterval ?? 300,
  ...effectiveOverride,
});

beforeEach(() => {
  watchers.length = 0;
  effectiveOverride = {};
  created = Promise.withResolvers<ControlledWatcher>();
  vi.mocked(watch).mockImplementation((_paths, options) => {
    const watcher = new ControlledWatcher(effectiveOptions(options));
    watchers.push(watcher);
    created.resolve(watcher);
    return watcher as unknown as FSWatcher;
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.mocked(watch).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gen-ui-state-ready-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = createGenUiStateStorage(root);
  cleanup.push(() => storage.dispose());
  return { root, storage };
}

it("shares one readiness boundary for concurrent observations of a scope", async () => {
  const { storage } = await fixture();
  const reads = [storage.get(target), storage.get({ ...target, path: "/workspace/other.html" })];
  const watcher = await created.promise;
  watcher.emit("ready");
  expect(await Promise.all(reads)).toEqual([null, null]);
  expect(watch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(watch).mock.calls[0]?.[1]).toMatchObject({
    usePolling: process.platform === "darwin",
    interval: 500,
    binaryInterval: 500,
    persistent: false,
  });
});

it("reads the durable external write after readiness rather than an early empty baseline", async () => {
  const { root, storage } = await fixture();
  const initial = storage.get(target);
  const observer = await created.promise;
  const writerCreated = Promise.withResolvers<ControlledWatcher>();
  vi.mocked(watch).mockImplementation((_paths, options) => {
    const watcher = new ControlledWatcher(effectiveOptions(options));
    watchers.push(watcher);
    writerCreated.resolve(watcher);
    return watcher as unknown as FSWatcher;
  });
  const writer = createGenUiStateStorage(root);
  cleanup.push(() => writer.dispose());
  const state = { modelContent: "written before observer ready", privateContent: null };
  const write = writer.set(target, state);
  (await writerCreated.promise).emit("ready");
  await write;
  observer.emit("ready");
  expect(await initial).toEqual(state);
});

it("propagates initialization failure and closes its watcher", async () => {
  const { storage } = await fixture();
  const read = storage.get(target);
  const rejection = expect(read).rejects.toThrow("fixture initialization failed");
  const watcher = await created.promise;
  watcher.emit("error", new Error("fixture initialization failed"));
  await rejection;
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

it("rejects disposed initialization and ignores late readiness without reopening", async () => {
  const { storage } = await fixture();
  const read = storage.get(target);
  const rejection = expect(read).rejects.toThrow("closed");
  const watcher = await created.promise;
  storage.dispose();
  await rejection;
  watcher.emit("ready");
  storage.dispose();
  expect(watcher.close).toHaveBeenCalledTimes(1);
  await expect(storage.get(target)).rejects.toThrow("closed");
  expect(watch).toHaveBeenCalledTimes(1);
});

it.each(["darwin", "linux", "win32"])(
  "rejects conflicting effective backend on %s",
  async (platform) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    effectiveOverride = { usePolling: platform !== "darwin" };
    const { storage } = await fixture();
    const rejection = expect(storage.get(target)).rejects.toThrow("platform observation policy");
    (await created.promise).emit("ready");
    await rejection;
    expect(watchers[0]?.close).toHaveBeenCalledTimes(1);
  },
);

it.each(["interval", "binaryInterval"] as const)(
  "rejects conflicting effective Darwin %s",
  async (field) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    effectiveOverride = { [field]: 123 };
    const { storage } = await fixture();
    const rejection = expect(storage.get(target)).rejects.toThrow("platform observation policy");
    (await created.promise).emit("ready");
    await rejection;
    expect(watchers[0]?.close).toHaveBeenCalledTimes(1);
  },
);

it.each(["linux", "win32"])(
  "accepts unrelated effective polling intervals with native %s",
  async (platform) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    effectiveOverride = { interval: 123, binaryInterval: 456 };
    const { storage } = await fixture();
    const read = storage.get(target);
    (await created.promise).emit("ready");
    expect(await read).toBeNull();
    expect(watchers[0]?.close).not.toHaveBeenCalled();
  },
);

it.each(["CHOKIDAR_USEPOLLING", "CHOKIDAR_INTERVAL"] as const)(
  "rejects and closes actual chokidar when %s overrides Darwin policy",
  async (key) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    const value = key === "CHOKIDAR_USEPOLLING" ? "0" : "123";
    vi.stubEnv(key, value);
    const actual = await vi.importActual<typeof import("chokidar")>("chokidar");
    let watcher: FSWatcher | undefined;
    let closing: ReturnType<typeof vi.spyOn>;
    vi.mocked(watch).mockImplementation((paths, options) => {
      watcher = actual.watch(paths, options);
      closing = vi.spyOn(watcher, "close");
      return watcher;
    });
    const { storage } = await fixture();
    await expect(storage.get(target)).rejects.toThrow("platform observation policy");
    expect(closing!).toHaveBeenCalledTimes(1);
    await closing!.mock.results[0]?.value;
    expect(watcher?.closed).toBe(true);
    expect(process.env[key]).toBe(value);
  },
);

it("initializes actual chokidar normally when effective options match", async () => {
  vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
  vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
  const actual = await vi.importActual<typeof import("chokidar")>("chokidar");
  let watcher: FSWatcher | undefined;
  vi.mocked(watch).mockImplementation((paths, options) => {
    watcher = actual.watch(paths, options);
    return watcher;
  });
  const { storage } = await fixture();
  expect(await storage.get(target)).toBeNull();
  expect(watcher?.closed).toBe(false);
});
