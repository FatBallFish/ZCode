import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type UtilityProcess } from "electron";
import {
  HostMessageTypes,
  InternalChannels,
  databaseStartupControlSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { reportDatabaseStartupState } from "./databaseStartupTelemetry.js";

let localStorageReady = false;
let quit: (() => void) | undefined;
export function configureDatabaseStartupQuit(handler: () => void): void {
  quit = handler;
}
const readyListeners = new Set<() => void>();
/** Main 只按 Host ready 调度既有 scheduler，不拥有迁移状态或账本。 */
export function onLocalDatabaseStartupReady(listener: () => void): void {
  if (localStorageReady) listener();
  else readyListeners.add(listener);
}

/**
 * 每个 Host 进程一份共享 relay 状态（2026-10-14 会话窗口附着引入）：
 * 同一 Host 可能同时服务多个窗口（主窗口 + 附着的会话窗口），latest 状态与
 * 控制命令路由必须按 Host 聚合，再转发到所有存活窗口。
 */
interface DatabaseStartupRelayRecord {
  startupId: string;
  latest: DatabaseStartupState | undefined;
  exited: boolean;
  forwards: Set<BrowserWindow>;
  controls: Set<(event: Electron.IpcMainEvent, raw: unknown) => void>;
}

const childRelayRecords = new WeakMap<UtilityProcess, DatabaseStartupRelayRecord>();
const windowBindings = new WeakMap<BrowserWindow, () => void>();
const hostStartupIds = new WeakMap<UtilityProcess, string>();

export function getDatabaseStartupPortPayload(
  child: UtilityProcess,
): { databaseStartupId: string } | undefined {
  const databaseStartupId = hostStartupIds.get(child);
  return databaseStartupId ? { databaseStartupId } : undefined;
}

function forwardToWindows(record: DatabaseStartupRelayRecord, state: DatabaseStartupState) {
  for (const win of record.forwards) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      record.forwards.delete(win);
      continue;
    }
    win.webContents.send(InternalChannels.DatabaseStartupState, state);
  }
}

function applyState(record: DatabaseStartupRelayRecord, state: DatabaseStartupState) {
  if (
    record.latest &&
    state.startupId === record.latest.startupId &&
    state.sequence <= record.latest.sequence
  ) {
    return;
  }
  record.latest = state;
  forwardToWindows(record, state);
  try {
    reportDatabaseStartupState(state);
  } catch {
    /* 遥测故障不阻断启动。 */
  }
  if (state.phase === "ready" && !localStorageReady) {
    localStorageReady = true;
    for (const listener of readyListeners) listener();
    readyListeners.clear();
  }
}

function createControlHandler(
  record: DatabaseStartupRelayRecord,
  child: UtilityProcess,
): (event: Electron.IpcMainEvent, raw: unknown) => void {
  return (event, raw) => {
    if (
      event.sender.isDestroyed() ||
      ![...record.forwards].some((win) => win.webContents === event.sender)
    ) {
      return;
    }
    const result = databaseStartupControlSchema.safeParse(raw);
    if (!result.success) return;
    if (result.data.action === "exit") {
      quit?.();
      return;
    }
    if (result.data.action === "snapshot" && record.latest) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(InternalChannels.DatabaseStartupState, record.latest);
      }
    }
    if (!record.exited) {
      child.postMessage({ type: HostMessageTypes.DatabaseStartupControl, control: result.data });
    }
  };
}

function markExited(record: DatabaseStartupRelayRecord) {
  record.exited = true;
  if (!record.latest) {
    const now = Date.now();
    record.latest = {
      schemaVersion: 1,
      startupId: record.startupId,
      attemptId: randomUUID(),
      sequence: 0,
      startedAt: now,
      updatedAt: now,
      phase: "starting",
      disk: [],
    };
  }
  // 即使旧代曾 ready，退出后的 reload 也只能读到失败，不能用旧证明放行新端口。
  if (record.latest.phase !== "failed") {
    applyState(record, {
      ...record.latest,
      sequence: record.latest.sequence + 1,
      updatedAt: Date.now(),
      failedPhase: record.latest.phase,
      phase: "failed",
      errorCode: "transport_closed",
    });
  }
}

function ensureRecord(child: UtilityProcess, startupId: string): DatabaseStartupRelayRecord {
  let record = childRelayRecords.get(child);
  if (!record) {
    record = {
      startupId,
      latest: undefined,
      exited: false,
      forwards: new Set(),
      controls: new Set(),
    };
    childRelayRecords.set(child, record);
    hostStartupIds.set(child, startupId);
    child.once("exit", () => markExited(record!));
  }
  return record;
}

/** 把窗口加入既有 Host 的 relay 转发（会话窗口附着源 Host 时使用）。 */
export function attachDatabaseStartupRelayWindow(
  win: BrowserWindow,
  child: UtilityProcess,
): { startupId: string } | undefined {
  const startupId = hostStartupIds.get(child);
  const record = childRelayRecords.get(child);
  if (!startupId || !record) {
    return undefined;
  }
  const control = createControlHandler(record, child);
  record.controls.add(control);
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  record.forwards.add(win);
  const dispose = () => {
    record.controls.delete(control);
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    record.forwards.delete(win);
    if (windowBindings.get(win) === dispose) windowBindings.delete(win);
  };
  windowBindings.set(win, dispose);
  win.once("closed", dispose);
  // 附着即回放最新状态，等待中的会话窗口立即过准入。
  if (record.latest) {
    forwardToWindows(record, record.latest);
  }
  return { startupId };
}

export function bindDatabaseStartupRelay(
  win: BrowserWindow,
  child: UtilityProcess,
  startupId = randomUUID(),
) {
  // 同窗口重建 Host 时，旧监听不能继续重放 ready 或接收用户控制命令。
  windowBindings.get(win)?.();
  const record = ensureRecord(child, startupId);
  const control = createControlHandler(record, child);
  record.controls.add(control);
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  record.forwards.add(win);
  const dispose = () => {
    record.controls.delete(control);
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    record.forwards.delete(win);
    hostStartupIds.delete(child);
    childRelayRecords.delete(child);
    if (windowBindings.get(win) === dispose) windowBindings.delete(win);
  };
  windowBindings.set(win, dispose);
  win.once("closed", dispose);
  return {
    receive: (state: DatabaseStartupState) => {
      if (record.exited || state.startupId !== record.startupId) return;
      applyState(record, state);
    },
    startupId: record.startupId,
  };
}
