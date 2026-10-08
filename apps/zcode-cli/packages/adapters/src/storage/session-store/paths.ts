import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";

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

export function ensureParentDir(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    maybeThrowStorageFsFault({ operation: "mkdir", path: parent });
    mkdirSync(parent, { recursive: true });
  }
}
