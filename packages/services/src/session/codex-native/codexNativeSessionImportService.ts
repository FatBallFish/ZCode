import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { normalize, resolve } from "node:path";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildImportedCodexTaskFile } from "#src/session/codex-native/buildImportedCodexTaskFile.js";
import type { CodexNativeImportedSessionSource } from "#src/session/codex-native/codexNativeImportedSessionTypes.js";
import { codexNativeSessionImportRepo } from "#src/session/codex-native/codexNativeSessionImportRepo.js";
import { parseCodexNativeSessionFile } from "#src/session/codex-native/codexNativeSessionParser.js";
import {
  buildSearchableTextFromMessages,
  writeImportedClaudeTaskSnapshot,
} from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("codex-native-import");

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
      const syncedMeta = await params.taskIndexRepo.syncTaskMeta({
        meta: {
          ...meta,
          migrationSource: "codex",
          workspaceIdentity: targetWorkspaceIdentity ?? meta.workspaceIdentity,
        },
        searchableText: buildSearchableTextFromMessages(sessionFile.messages),
        // 已导入会话被删除/归档后再次导入，不能继承旧行隐藏状态（与 Claude 导入同理）。
        archived: false,
        deleted: false,
      });
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
