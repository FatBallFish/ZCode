import { copyFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir, getWorkspaceHash } from "#src/paths.js";
import { extractCodexNativeSessionHeadInfo } from "#src/session/codex-native/codexNativeSessionParser.js";
import { readJsonLinesFileHead } from "#src/session/claude-native/sessionHistoryJsonl.js";

const logger = createServiceLogger("codex-native-import");

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Codex CLI 原生历史扫描（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）。
 * 与 Claude 导入同构：repo 只负责发现/复制，解析在 parser，落库在 import service。
 */
class CodexNativeSessionImportRepo {
  /** CODEX_HOME 优先（Codex CLI 官方环境变量）；否则各 home 候选下的 .codex/sessions。 */
  private getSessionRoots(): string[] {
    const roots = new Set<string>();

    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome) {
      roots.add(join(codexHome, "sessions"));
    }

    const homes = new Set<string>();
    homes.add(homedir());
    const envHome = process.env.HOME?.trim();
    if (envHome) {
      homes.add(envHome);
    }

    for (const home of homes) {
      roots.add(join(home, ".codex", "sessions"));
    }

    return [...roots];
  }

  private async findSessionFile(rootDir: string, sessionId: string): Promise<string | null> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          const nestedMatch = await this.findSessionFile(entryPath, sessionId);
          if (nestedMatch) {
            return nestedMatch;
          }
          continue;
        }
        if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
          return entryPath;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async collectJsonlFiles(rootDir: string): Promise<string[]> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await this.collectJsonlFiles(entryPath)));
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }

      return files;
    } catch {
      return [];
    }
  }

  async scanImportableSessions(params: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;
    const sessionFiles = [
      ...new Set(
        (
          await Promise.all(
            this.getSessionRoots().map((rootDir) => this.collectJsonlFiles(rootDir)),
          )
        ).flat(),
      ),
    ];
    const candidates: ZCodeImportableSessionCandidate[] = [];

    for (const filePath of sessionFiles) {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      const updatedAt = Math.trunc(fileStat.mtimeMs);
      if (params.modifiedSince && updatedAt < params.modifiedSince) {
        continue;
      }

      try {
        // rollout 首行是 session_meta（cwd），其后是注入上下文与首条用户消息；
        // 32 条头部足够覆盖「meta + 注入块 + 首条可见输入」。
        const headRecords = await readJsonLinesFileHead(filePath, 32);
        const headInfo = extractCodexNativeSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(headInfo.workspacePath) !== workspaceKey
        ) {
          continue;
        }

        candidates.push({
          provider: "codex",
          sessionId: basename(filePath, ".jsonl"),
          workspacePath: headInfo.workspacePath,
          sourcePath: filePath,
          updatedAt,
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.previewTitle ? { previewTitle: headInfo.previewTitle } : {}),
        });
      } catch (error) {
        logger.warn(undefined, `扫描 Codex 原生 session 失败 path=${filePath}`, error);
      }
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const limited =
      typeof params.limit === "number" && params.limit > 0
        ? candidates.slice(0, params.limit)
        : candidates;

    logger.info(
      undefined,
      `Codex 原生 session 扫描完成 workspaceFilter=${params.workspacePath ?? "all"} fileCount=${sessionFiles.length} candidateCount=${limited.length}`,
    );

    return limited;
  }

  async findImportableSession(params: {
    workspacePath?: string;
    sessionId: string;
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;

    for (const sessionRoot of this.getSessionRoots()) {
      const filePath = await this.findSessionFile(sessionRoot, params.sessionId);
      if (!filePath) {
        continue;
      }

      try {
        const fileStat = await stat(filePath);
        const headRecords = await readJsonLinesFileHead(filePath, 32);
        const headInfo = extractCodexNativeSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(headInfo.workspacePath) !== workspaceKey
        ) {
          continue;
        }

        return {
          provider: "codex",
          sessionId: params.sessionId,
          workspacePath: headInfo.workspacePath,
          sourcePath: filePath,
          updatedAt: Math.trunc(fileStat.mtimeMs),
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.previewTitle ? { previewTitle: headInfo.previewTitle } : {}),
        };
      } catch (error) {
        logger.warn(undefined, `查找 Codex 原生 session 失败 sessionId=${params.sessionId}`, error);
      }
    }

    return null;
  }

  async copySessionFileToWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourcePath: string;
  }): Promise<{ outputPath: string; createdOutputPaths: string[] }> {
    // 导入副本布局 ~/.mikiko/v2/agent-config/codex/{workspaceHash}/sessions/<rollout 文件名>；
    // 与 Claude 导入的 agent-config/claude/... 平行，互不混写。
    const outputPath = join(
      getAppConfigDir(),
      "agent-config",
      "codex",
      getWorkspaceHash(params.workspacePath, params.workspaceIdentity),
      "sessions",
      basename(params.sourcePath),
    );
    const outputDir = dirname(outputPath);
    const existedBefore = await pathExists(outputPath);
    const tempPath = `${outputPath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;

    await mkdir(outputDir, { recursive: true });
    await copyFile(params.sourcePath, tempPath);
    await rename(tempPath, outputPath);

    return {
      outputPath,
      createdOutputPaths: existedBefore ? [] : [outputPath],
    };
  }
}

export const codexNativeSessionImportRepo = new CodexNativeSessionImportRepo();
