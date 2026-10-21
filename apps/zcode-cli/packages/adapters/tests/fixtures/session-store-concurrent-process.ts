import { openStartupSqliteSessionStore } from "../../src/storage/index.ts";

let prepared: { attemptId: string; dbPath: string } | undefined;
let running = false;
let stopping = false;
const disconnect = () => {
  if (process.connected) process.disconnect?.();
};

process.send?.({ type: "ready" });
process.on(
  "message",
  async (message: { attemptId?: unknown; dbPath?: unknown; type?: unknown }) => {
    if (message.type === "stop") {
      stopping = true;
      if (!running) disconnect();
      return;
    }
    if (
      message.type === "prepare" &&
      !running &&
      !prepared &&
      typeof message.attemptId === "string" &&
      typeof message.dbPath === "string"
    ) {
      prepared = { attemptId: message.attemptId, dbPath: message.dbPath };
      process.send?.({ attemptId: prepared.attemptId, type: "prepared" });
      return;
    }
    if (
      message.type !== "start" ||
      running ||
      !prepared ||
      message.attemptId !== prepared.attemptId
    ) {
      process.exitCode = 1;
      disconnect();
      return;
    }
    const { attemptId, dbPath } = prepared;
    prepared = undefined;
    running = true;
    let result;
    try {
      // 每轮都真实创建/关闭新store；进程只复用模块加载，不缓存任何数据库或迁移结果。
      const store = await openStartupSqliteSessionStore({ dbPath });
      try {
        result = { migrationIds: store.debugMigrationIds(), ok: true };
      } finally {
        store.close();
      }
    } catch (error) {
      result = {
        kind:
          typeof error === "object" && error !== null && "kind" in error
            ? String(error.kind)
            : undefined,
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    } finally {
      running = false;
    }
    if (process.connected) process.send?.({ attemptId, result, type: "result" });
    if (stopping) disconnect();
  },
);
