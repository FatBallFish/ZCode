export type ForkCommitFaultStage =
  | "afterChild"
  | "afterMessages"
  | "afterGoal"
  | "afterEntries"
  | "afterInput"
  | "afterCommandFact"
  | "beforeCommit";

export interface SqliteSessionStoreOptions {
  dbPath?: string;
  /**
   * 旧版（v1.0.6 及之前，~/.zcode）会话库位置：新库 getSession miss 时按会话惰性
   * 回迁（specs/agent/data-dir-isolation.md 规则 3）。缺省取
   * MIKIKO_LEGACY_SESSION_DB 环境变量，再回退 ~/.zcode/cli/db/db.sqlite；
   * 显式传 null 可禁用回迁（测试隔离用）。
   */
  legacyDbPath?: string | null;
  /** 仅供事务原子性测试；生产调用不得设置。 */
  forkCommitFaultAt?: ForkCommitFaultStage;
  /** 仅供启动锁等待边界测试；生产调用使用默认值。 */
  startupLockTimeoutMs?: number;
}

export interface SessionStoreDebugCounts {
  sessions: number;
  messages: number;
  parts: number;
  todos: number;
  targets: number;
  sessionEntries: number;
  permissions: number;
  localSettings: number;
  schemaMigrations: number;
  inputHistory: number;
  modelUsage: number;
  toolUsage: number;
  turnUsage: number;
}
