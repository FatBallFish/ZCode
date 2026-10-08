import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

/**
 * v1.0.7 数据目录隔离的老会话回迁（specs/agent/data-dir-isolation.md 规则 3）：
 * v1.0.6 及之前的会话留在旧库 ~/.zcode/cli/db/db.sqlite，新库 getSession miss 时
 * 按会话惰性导入（session 行 + 所有含 session_id 列的表行，列交集 + INSERT OR IGNORE），
 * 修复更新后点开历史会话报 fault.subscribe.sessionNotFound。
 */

const SESSION_ID = "sess_legacy1" as SessionId;

function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

test("旧库惰性回迁：miss 触发导入、行齐、幂等；未命中与禁用保持 null", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "legacy-session-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // 旧库：同一套迁移建 schema，再以原始 SQL 写入 v1.0.6 形态的会话行
  //（回迁只搬行，不依赖旧库由哪个版本的写入器产生）。
  const legacyPath = join(base, "legacy", "db.sqlite");
  const legacyBootstrap = new SqliteSessionStore({ dbPath: legacyPath, legacyDbPath: null });
  legacyBootstrap.close();
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values ('${SESSION_ID}', 'proj-1', 'slug-1', '/repos/demo', '旧会话', '1.0.6', 1, 2)`,
  );
  legacy.exec(
    `insert into message (id, session_id, time_created, time_updated, data)
     values ('msg-1', '${SESSION_ID}', 1, 2, '{}')`,
  );
  legacy.exec(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values ('part-1', 'msg-1', '${SESSION_ID}', 1, 2, '{}')`,
  );
  legacy.exec(
    `insert into todo (session_id, content, status, priority, position, time_created, time_updated)
     values ('${SESSION_ID}', '任务', 'pending', 'high', 0, 1, 2)`,
  );
  legacy.close();

  // 新库：resume miss → 回迁 → 命中。
  const mainPath = join(base, "main", "db.sqlite");
  const store = new SqliteSessionStore({ dbPath: mainPath, legacyDbPath: legacyPath });
  const session = await store.getSession(SESSION_ID);
  assert.ok(session, "miss 后应从旧库回迁并命中");
  assert.equal(session.title, "旧会话");
  assert.equal(session.directory, "/repos/demo");

  // 会话作用域各表行均已搬运。
  const main = new DatabaseSync(mainPath, { readOnly: true });
  assert.equal(countRows(main, `select count(*) as c from message where session_id = '${SESSION_ID}'`), 1);
  assert.equal(countRows(main, `select count(*) as c from part where session_id = '${SESSION_ID}'`), 1);
  assert.equal(countRows(main, `select count(*) as c from todo where session_id = '${SESSION_ID}'`), 1);
  main.close();

  // 幂等：重复 getSession 不产生重复行；未命中 id 返回 null。
  await store.getSession(SESSION_ID);
  const again = new DatabaseSync(mainPath, { readOnly: true });
  assert.equal(countRows(again, `select count(*) as c from message where session_id = '${SESSION_ID}'`), 1);
  again.close();
  assert.equal(await store.getSession("sess_never_existed" as SessionId), null);
  store.close();

  // 禁用回迁（显式 null，测试隔离）：miss 保持 notFound 语义。
  const plainPath = join(base, "plain", "db.sqlite");
  const plain = new SqliteSessionStore({ dbPath: plainPath, legacyDbPath: null });
  assert.equal(await plain.getSession(SESSION_ID), null);
  plain.close();
});

test("旧库路径可经 MIKIKO_LEGACY_SESSION_DB 覆盖；指向当前库文件时自动禁用", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "legacy-session-env-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
    delete process.env.MIKIKO_LEGACY_SESSION_DB;
  });

  const legacyPath = join(base, "legacy", "db.sqlite");
  const legacyBootstrap = new SqliteSessionStore({ dbPath: legacyPath, legacyDbPath: null });
  legacyBootstrap.close();
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values ('sess_env', 'proj-1', 'slug-1', '/repos/demo', 'env 会话', '1.0.6', 1, 2)`,
  );
  legacy.close();

  process.env.MIKIKO_LEGACY_SESSION_DB = legacyPath;
  const mainPath = join(base, "main", "db.sqlite");
  const store = new SqliteSessionStore({ dbPath: mainPath });
  const session = await store.getSession("sess_env" as SessionId);
  assert.ok(session, "env 指定的旧库应生效");
  assert.equal(session.title, "env 会话");
  store.close();
  delete process.env.MIKIKO_LEGACY_SESSION_DB;

  // 旧库路径 == 当前库路径时禁用（避免自己读自己造成无意义回迁）。
  const samePath = join(base, "same", "db.sqlite");
  const bootstrap = new SqliteSessionStore({ dbPath: samePath, legacyDbPath: null });
  bootstrap.close();
  process.env.MIKIKO_LEGACY_SESSION_DB = samePath;
  const same = new SqliteSessionStore({ dbPath: samePath });
  assert.equal(await same.getSession("sess_anybody" as SessionId), null);
  same.close();
  delete process.env.MIKIKO_LEGACY_SESSION_DB;
});
