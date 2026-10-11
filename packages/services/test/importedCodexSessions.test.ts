import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { codexNativeSessionImportRepo } from "../src/session/codex-native/codexNativeSessionImportRepo.js";
import {
  extractCodexNativeSessionHeadInfo,
  parseCodexNativeSessionFile,
} from "../src/session/codex-native/codexNativeSessionParser.js";
import { buildImportedCodexTaskFile } from "../src/session/codex-native/buildImportedCodexTaskFile.js";
import { importCodexNativeSessions } from "../src/session/codex-native/codexNativeSessionImportService.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { JsonLineRecord } from "../src/session/claude-native/jsonLineRecord.js";

/** 构造一段最小但真实的 Codex rollout jsonl（session_meta + 注入块 + 两个对话轮次）。 */
function buildRolloutLines(params: {
  cwd: string;
  userText: string;
  assistantText: string;
  secondUserText?: string;
  secondAssistantText?: string;
}): string[] {
  const lines: JsonLineRecord[] = [
    {
      timestamp: "2026-10-01T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "9b7b1a0e-1111-4222-8333-444455556666",
        timestamp: "2026-10-01T10:00:00.000Z",
        cwd: params.cwd,
        originator: "codex_cli_rs",
      },
    },
    {
      timestamp: "2026-10-01T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<environment_context>mode=test</environment_context>" },
        ],
      },
    },
    {
      timestamp: "2026-10-01T10:00:01.000Z",
      type: "turn_context",
      payload: { cwd: params.cwd, model: "gpt-5.1-codex" },
    },
    {
      timestamp: "2026-10-01T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: params.userText }],
      },
    },
    {
      timestamp: "2026-10-01T10:00:03.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "重复播报，不应进入导入" },
    },
    {
      timestamp: "2026-10-01T10:00:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: params.assistantText }],
      },
    },
  ];
  if (params.secondUserText) {
    lines.push(
      {
        timestamp: "2026-10-01T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: params.secondUserText }],
        },
      },
      {
        timestamp: "2026-10-01T10:01:05.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
        },
      },
      {
        timestamp: "2026-10-01T10:01:10.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: params.secondAssistantText ?? "第二条回复" }],
        },
      },
    );
  }
  return lines.map((line) => JSON.stringify(line));
}

test("codex head info extracts workspace and filters injected user text", async () => {
  const lines = buildRolloutLines({
    cwd: "/tmp/demo-project",
    userText: "帮我看下构建失败的原因",
    assistantText: "是测试挂了。",
  });
  const headInfo = extractCodexNativeSessionHeadInfo(lines.map((line) => JSON.parse(line)));
  assert.equal(headInfo.workspacePath, "/tmp/demo-project");
  assert.equal(headInfo.previewTitle, "帮我看下构建失败的原因");
  assert.equal(headInfo.createdAt, Date.parse("2026-10-01T10:00:02.000Z"));
});

test("codex parser aggregates turns and drops non-visible records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-codex-parse-"));
  const filePath = join(dir, "rollout-2026-10-01T10-00-00-9b7b1a0e-1111.jsonl");
  await writeFile(
    filePath,
    `${buildRolloutLines({
      cwd: "/tmp/demo-project",
      userText: "第一个问题",
      assistantText: "第一段回答",
      secondUserText: "第二个问题",
      secondAssistantText: "第二段回答",
    }).join("\n")}\n`,
  );
  try {
    const source = await parseCodexNativeSessionFile({
      filePath,
      workspacePath: "/tmp/demo-project",
      sessionId: "rollout-2026-10-01T10-00-00-9b7b1a0e-1111",
    });
    assert.equal(source.provider, "codex");
    assert.equal(source.workspacePath, "/tmp/demo-project");
    assert.equal(source.model, "gpt-5.1-codex");
    assert.equal(source.migrationSource, "codex");
    assert.deepEqual(
      source.messages.map((message) => [message.role, message.content, message.turnIndex]),
      [
        ["user", "第一个问题", 0],
        ["assistant", "第一段回答", 0],
        ["user", "第二个问题", 1],
        ["assistant", "第二段回答", 1],
      ],
    );
    assert.equal(source.createdAt, Date.parse("2026-10-01T10:00:02.000Z"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codex repo scans CODEX_HOME and imports via codex pipeline", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-codex-import-"));
  setDataBaseDir(dataDir);
  // 隔离真实 home：repo 的 root 候选包含 homedir() 与 $HOME，二者都指到临时目录，
  // 避免扫描到本机真实的 ~/.codex（os.homedir 在 POSIX 下优先读 $HOME）。
  const isolatedHome = join(dataDir, "isolated-home");
  await mkdir(isolatedHome, { recursive: true });
  const codexHome = join(dataDir, "codex-home");
  const projectDir = join(dataDir, "demo-project");
  await mkdir(join(codexHome, "sessions", "2026", "10", "01"), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const sessionId = "rollout-2026-10-01T10-00-00-9b7b1a0e-1111";
  const emptySessionId = "rollout-2026-10-02T00-00-00-empty";
  const rolloutPath = join(codexHome, "sessions", "2026", "10", "01", `${sessionId}.jsonl`);
  await writeFile(
    rolloutPath,
    `${buildRolloutLines({
      cwd: projectDir,
      userText: "导入我",
      assistantText: "好的。",
    }).join("\n")}\n`,
  );
  // 无可见消息的 rollout 扫描仍会出现（有 cwd），导入时计入 failed。
  await writeFile(
    join(codexHome, "sessions", "2026", "10", "01", `${emptySessionId}.jsonl`),
    `${JSON.stringify({ timestamp: "2026-10-02T00:00:00.000Z", type: "session_meta", payload: { id: "empty", cwd: projectDir } })}\n`,
  );
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = isolatedHome;
  t.after(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  const candidates = await codexNativeSessionImportRepo.scanImportableSessions({});
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.provider === "codex"));
  assert.ok(candidates.some((candidate) => candidate.sessionId === sessionId));
  assert.ok(candidates.every((candidate) => candidate.workspacePath === projectDir));

  const workspaceFiltered = await codexNativeSessionImportRepo.scanImportableSessions({
    workspacePath: "/definitely/not/here",
  });
  assert.equal(workspaceFiltered.length, 0);

  const taskIndexRepo = new TaskIndexRepo(join(dataDir, "tasks.sqlite"));
  t.after(() => {
    taskIndexRepo.close();
  });
  const importedMeta: ZCodeTaskMeta[] = [];
  const result = await importCodexNativeSessions({
    taskIndexRepo,
    sessionIds: [sessionId, emptySessionId, "rollout-does-not-exist"],
    createImportedSession: async (source) => {
      const sessionFile = buildImportedCodexTaskFile(source);
      return sessionFile.meta;
    },
    onTaskImported: (meta) => {
      importedMeta.push(meta);
    },
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.provider, "codex");
  assert.equal(result.imported[0]?.workspacePath, projectDir);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "session_not_found_or_workspace_mismatch");
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.sessionId, emptySessionId);
  assert.equal(importedMeta.length, 1);
  assert.equal(importedMeta[0]?.migrationSource, "codex");
  assert.ok(importedMeta[0]?.taskId.startsWith("codex-import-"));

  // 导入副本落在 {dataBaseDir}/.mikiko/v2/agent-config/codex/{workspaceHash}/sessions/，
  // 且不修改原始 rollout。
  const copyRoot = join(dataDir, ".mikiko", "v2", "agent-config", "codex");
  const copiedTree = await readdir(copyRoot, { recursive: true });
  const copiedRollout = copiedTree.filter((entry) => entry.endsWith(`${sessionId}.jsonl`));
  assert.equal(copiedRollout.length, 1);
  assert.match(copiedRollout[0] ?? "", /sessions/u);

  const taskFile = buildImportedCodexTaskFile(
    await parseCodexNativeSessionFile({
      filePath: rolloutPath,
      workspacePath: projectDir,
      sessionId,
    }),
  );
  assert.equal(taskFile.meta.migrationSource, "codex");
  assert.equal(taskFile.meta.title, "导入我");

  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
