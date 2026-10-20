import { homedir } from "node:os";
import { join } from "node:path";

export function getDefaultSessionDbPath(): string {
  return join(homedir(), ".mikiko", "cli", "db", "db.sqlite");
}

/**
 * v1.0.6 及之前版本的 agent 会话库默认位置（specs/agent/data-dir-isolation.md）。
 * v1.0.7 数据根切到 ~/.mikiko 后，老会话 resume miss 时从这里只读回迁（按会话惰性导入）。
 */
export function getDefaultLegacySessionDbPath(): string {
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}
