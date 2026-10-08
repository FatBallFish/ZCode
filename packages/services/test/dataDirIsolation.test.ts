import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setDataBaseDir } from "../src/paths.js";
import { resolveModelIODirs } from "../src/zcode-agent/modelTrajectoryFileTail.js";
// agent 契约直接读源文件保持单一事实源：apps/zcode-cli 子 workspace 无独立测试基建，
// 这里锚定「agent 写入根」与「host 读取根」一致，防止任一侧路径再次漂移（写读失配会让
// 调用轨迹全量读空，2026-10-08 的 storage.dir=~/.zcode 与读取侧 ~/.mikiko 失配即此事故）。
import { DefaultRuntimeConfig as DefaultConfig } from "../../../apps/zcode-cli/packages/contracts/src/config/index.js";
import {
  SAVED_WORKFLOW_GLOBAL_DIR,
  SAVED_WORKFLOW_PROJECT_DIR,
} from "../../../apps/zcode-cli/packages/contracts/src/tools/saved-workflow.js";
import { workflowRunsDir } from "../../../apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-entry-file.js";

/**
 * specs/agent/data-dir-isolation.md：Mikiko 与官方 ZCode 目录级隔离。
 *
 * 1. agent 存储默认根必须是 ~/.mikiko（storage.dir 是 model-io、db、plugins、
 *    skills、MCP 存储等派生目录的唯一事实源）；
 * 2. host 调用轨迹读取根必须与 storage.dir 派生目录一致（写读一致性）；
 * 3. 保存工作流 / workflow-runs 等散落常量与主根同品牌。
 */
test("agent storage 默认根是 ~/.mikiko 且 session db 从同一根派生", () => {
  assert.equal(DefaultConfig.storage.dir, "~/.mikiko");
  assert.ok(
    DefaultConfig.storage.sessionDbPath.startsWith(`${DefaultConfig.storage.dir}/cli/db/`),
    `sessionDbPath 应从 storage.dir 派生，实际 ${DefaultConfig.storage.sessionDbPath}`,
  );
});

test("host 调用轨迹读取根与 agent model-io 写入根一致", () => {
  // 复刻 bootstrap getModelIoDir 的派生：storage.dir → cliStorageRoot → debug/rollout。
  const storageRoot = DefaultConfig.storage.dir.replace(/^~/, homedir());
  const cliStorageRoot = join(storageRoot, "cli");

  const dirs = resolveModelIODirs();
  assert.ok(dirs.includes(join(cliStorageRoot, "debug")), "读取根缺少 dev 态 debug 目录");
  assert.ok(dirs.includes(join(cliStorageRoot, "rollout")), "读取根缺少生产态 rollout 目录");
  for (const dir of dirs) {
    assert.ok(
      dir.includes(".mikiko"),
      `读取根 ${dir} 必须落在 Mikiko 数据根下，不允许回到共享的 ~/.zcode`,
    );
  }
});

test("MIKIKO_DATA_BASE_DIR 指向的数据根同样派生 .mikiko/cli 读取目录", () => {
  setDataBaseDir("/data/mikiko-host");
  try {
    const dirs = resolveModelIODirs();
    assert.ok(dirs.includes(join("/data/mikiko-host", ".mikiko", "cli", "debug")));
    assert.ok(dirs.includes(join("/data/mikiko-host", ".mikiko", "cli", "rollout")));
  } finally {
    setDataBaseDir(null);
  }
});

test("保存工作流与 workflow-runs 目录跟随 Mikiko 品牌", () => {
  assert.equal(SAVED_WORKFLOW_PROJECT_DIR, ".mikiko/workflows");
  assert.equal(SAVED_WORKFLOW_GLOBAL_DIR, ".mikiko/workflows");
  assert.equal(workflowRunsDir("/tmp/project"), join("/tmp/project", ".mikiko", "workflow-runs"));
});
