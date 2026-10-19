import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import { DatabaseSync } from "node:sqlite";

/** 测试共用：内存版 KVNamespace mock（签名对齐 workers-types，含 metadata 与 TTL 选项）。 */
export function createMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  const kv = {
    async get(key: string, type?: string): Promise<string | unknown | null> {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async getWithMetadata(key: string) {
      const value = store.get(key);
      return { value: value === undefined ? null : value, metadata: null };
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
      const prefix = options?.prefix ?? "";
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      };
    },
  };
  return kv as unknown as KVNamespace;
}

/** 测试共用：内存版 R2Bucket mock（本服务端只用 get/put，其余按接口要求补齐为不可达桩）。 */
export function createMemoryR2(): R2Bucket {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>();
  const r2 = {
    async put(
      key: string,
      value: ArrayBuffer,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      store.set(key, { body: value, contentType: options?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        body: entry.body,
        size: entry.body.byteLength,
        httpMetadata: { contentType: entry.contentType },
      };
    },
    async head() {
      return null;
    },
    async delete() {
      return undefined;
    },
    async list() {
      return { truncated: false, objects: [] };
    },
    async createMultipartUpload() {
      throw new Error("not implemented in memory mock");
    },
    async resumeMultipartUpload() {
      throw new Error("not implemented in memory mock");
    },
  };
  return r2 as unknown as R2Bucket;
}

/**
 * 测试共用：node:sqlite 实现的内存版 D1Database shim（跑真 SQL，零额外依赖；
 * Node ≥23.4 起 node:sqlite 免 flag 可用）。仅覆盖本服务用到的
 * prepare/bind/first/all/run/batch 子集。可选传入 migration SQL 预建 schema。
 */
export function createMemoryD1(migrationSql?: string): D1Database {
  const db = new DatabaseSync(":memory:");
  if (migrationSql !== undefined && migrationSql.length > 0) {
    db.exec(migrationSql);
  }
  interface BoundStatement {
    sql: string;
    params: unknown[];
  }
  const makeBound = (bound: BoundStatement) => ({
    async first<T>(): Promise<T | null> {
      const row = db.prepare(bound.sql).get(...(bound.params as never[])) as T | undefined;
      return row === undefined ? null : row;
    },
    async all<T>(): Promise<{ results: T[] }> {
      const rows = db.prepare(bound.sql).all(...(bound.params as never[])) as T[];
      return { results: rows };
    },
    async run(): Promise<{ meta: { changes: number } }> {
      const info = db.prepare(bound.sql).run(...(bound.params as never[]));
      return { meta: { changes: Number(info.changes) } };
    },
  });
  const d1 = {
    prepare(sql: string) {
      const bound: BoundStatement = { sql, params: [] };
      return {
        bind(...args: unknown[]) {
          bound.params = args;
          return makeBound(bound);
        },
        ...makeBound(bound),
      };
    },
    async batch(statements: unknown[]) {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) {
        results.push(
          await (statement as { run(): Promise<{ meta: { changes: number } }> }).run(),
        );
      }
      return results;
    },
  };
  return d1 as unknown as D1Database;
}
