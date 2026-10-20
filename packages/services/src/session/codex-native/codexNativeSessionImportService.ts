import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { normalize, resolve } from "node:path";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedCodexTaskFile } from "#src/session/codex-native/buildImportedCodexTaskFile.js";
import { buildImportedCodexTaskId } from "#src/session/codex-native/buildImportedCodexTaskFile.js";
import type { CodexNativeImportedSessionSource } from "#src/session/codex-native/codexNativeImportedSessionTypes.js";
import { codexNativeSessionImportRepo } from "#src/session/codex-native/codexNativeSessionImportRepo.js";
import { parseCodexNativeSessionFile } from "#src/session/codex-native/codexNativeSessionParser.js";
import {
  buildSearchableTextFromMessages,
  writeImportedClaudeTaskSnapshot,
} from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("codex-native-import");

/**
 * 「已在 App 内延续」判定松弛量：导入时 task meta.updatedAt 与源 rollout mtime 之间
 * 存在消息时间戳/落盘顺序噪声；超出该窗口的活动（续聊、改名）才视为用户延续。
 */
const CONTINUATION_SLACK_MS = 5 * 60_000;

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function cleanupCreatedArtifacts(paths: readonly string[]): Promise<void> {
  for (const path of new Set(paths)) {
    try {
      await rm(path, { force: true });
    } catch {
      // 清理失败不阻断主流程
    }
  }
}

/**
 * Codex 原生 session 批量导入（与 importClaudeNativeSessions 同构）：
 * find candidate → 校验 workspace 存在 → 复制 rollout 副本 → 解析可见消息 →
 * createSession（真实 ZCode session + importedHistory source="codex"）→
 * 写最小 task snapshot → 同步 tasks-index（migrationSource="codex"）。
 */
export async function importCodexNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession: (source: CodexNativeImportedSessionSource) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
  /** 已存在的同 taskId 任务 meta（幂等跳过判定用；缺省时退化为无条件导入）。 */
  getExistingTaskMeta?: (params: {
    taskId: string;
    workspacePath: string;
  }) => Promise<ZCodeTaskMeta | null>;
}): Promise<ZCodeImportSessionsResult> {
  const normalizedSessionIds = [
    ...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean)),
  ];
  const result: ZCodeImportSessionsResult = {
    imported: [],
    skipped: [],
    failed: [],
  };

  logger.info(
    undefined,
    `开始导入 Codex 原生 session workspaceFilter=${params.workspacePath ?? "all"} count=${normalizedSessionIds.length}`,
  );

  for (const sessionId of normalizedSessionIds) {
    let createdOutputPaths: string[] = [];
    let importedWorkspacePath: string | undefined;
    try {
      const candidate = await codexNativeSessionImportRepo.findImportableSession({
        workspacePath: params.workspacePath,
        sessionId,
      });
      if (!candidate) {
        result.skipped.push({
          provider: "codex",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        });
        continue;
      }

      importedWorkspacePath = candidate.workspacePath;
      if (!(await workspacePathExists(importedWorkspacePath))) {
        result.skipped.push({
          provider: "codex",
          sessionId,
          reason: "workspace_path_missing",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      if (
        params.workspacePath &&
        normalizePathForComparison(importedWorkspacePath) !==
          normalizePathForComparison(params.workspacePath)
      ) {
        result.skipped.push({
          provider: "codex",
          sessionId,
          reason: "session_not_found_or_workspace_mismatch",
          workspacePath: importedWorkspacePath,
        });
        continue;
      }

      // 会话级幂等（2026-10-12）：taskId 确定性派生，重复导入同一 rollout 命中同一任务。
      // 已存在且 updatedAt 明显晚于源文件（超出松弛量）= 用户在 App 内续聊/改名过，
      // 整体跳过不覆盖；否则继续走导入——createSession 的消息级清理会先删旧导入消息、
      // 保留续聊内容，再重写导入消息与标题，即「已导入异常会话的自动修复」。
      if (params.getExistingTaskMeta) {
        const existingMeta = await params
          .getExistingTaskMeta({
            taskId: buildImportedCodexTaskId(importedWorkspacePath, sessionId),
            workspacePath: importedWorkspacePath,
          })
          .catch(() => null);
        if (existingMeta && existingMeta.updatedAt - candidate.updatedAt > CONTINUATION_SLACK_MS) {
          result.skipped.push({
            provider: "codex",
            sessionId,
            reason: "session_continued_in_app",
            workspacePath: importedWorkspacePath,
          });
          continue;
        }
      }

      const copiedArtifacts = await codexNativeSessionImportRepo.copySessionFileToWorkspace({
        workspacePath: importedWorkspacePath,
        workspaceIdentity: params.workspacePath ? params.workspaceIdentity : undefined,
        sourcePath: candidate.sourcePath,
      });
      createdOutputPaths = copiedArtifacts.createdOutputPaths;

      const importedSource = await parseCodexNativeSessionFile({
        filePath: candidate.sourcePath,
        workspacePath: importedWorkspacePath,
        sessionId,
        sourcePath: candidate.sourcePath,
        fallbackCreatedAt: candidate.createdAt,
        fallbackUpdatedAt: candidate.updatedAt,
      });

      const targetWorkspaceIdentity = params.workspacePath ? params.workspaceIdentity : undefined;
      const meta = await params.createImportedSession(importedSource);
      const sessionFile = buildImportedCodexTaskFile(importedSource, meta.taskId);
      // writeImportedClaudeTaskSnapshot 只写 LegacyTaskSessionFile（结构 provider 无关），复用。
      await writeImportedClaudeTaskSnapshot({
        sessionFile: {
          ...sessionFile,
          meta: {
            ...sessionFile.meta,
            ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
          },
        },
      });
      // 上游收敛后 CLI 是会话事实唯一写者；导入只补展示信息并恢复组织态，不能整行覆盖事实。
      const syncedMeta = await params.taskIndexRepo.updateTaskPresentation({
        ...meta,
        workspaceIdentity: targetWorkspaceIdentity ?? meta.workspaceIdentity,
        presentation: { migrationSource: "codex" },
        searchableText: buildSearchableTextFromMessages(sessionFile.messages),
      });
      if (!syncedMeta) throw new Error("CLI import did not persist session facts");
      await params.taskIndexRepo.updateTaskState({ ...syncedMeta, patch: { archived: false } });
      params.onTaskImported(syncedMeta);

      result.imported.push({
        provider: "codex",
        sessionId,
        taskId: syncedMeta.taskId,
        workspacePath: syncedMeta.workspacePath,
      });
    } catch (error) {
      await cleanupCreatedArtifacts(createdOutputPaths);
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入 Codex 原生 session 失败 session=${sessionId}`, error);
      result.failed.push({
        provider: "codex",
        sessionId,
        reason,
        ...(importedWorkspacePath ? { workspacePath: importedWorkspacePath } : {}),
      });
    }
  }

  logger.info(
    undefined,
    `Codex 原生 session 导入完成 imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
