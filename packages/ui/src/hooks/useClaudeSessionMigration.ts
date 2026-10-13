import { useCallback, useMemo, useRef, useState } from "react";
import type { ZCodeImportSessionsResult, ZCodeImportableSessionCandidate } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

export type ClaudeMigrationRange = "all" | "7d" | "30d" | "90d";
type ClaudeMigrationWorkspaceFilterMode = "all" | "current";

export const DEFAULT_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
export const UNLIMITED_SCAN_LIMIT_INPUT = "unlimited";

const RANGE_TO_DURATION_MS: Record<Exclude<ClaudeMigrationRange, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

function resolveModifiedSince(range: ClaudeMigrationRange): number | undefined {
  if (range === "all") {
    return undefined;
  }

  return Date.now() - RANGE_TO_DURATION_MS[range];
}

export function resolveClaudeMigrationScanLimit(limitInput: string): number | undefined {
  if (limitInput === UNLIMITED_SCAN_LIMIT_INPUT) {
    return undefined;
  }

  const parsed = Number.parseInt(limitInput.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_SCAN_LIMIT);
}

export interface ClaudeSessionMigrationSupportState {
  supported: boolean;
  reason?: "desktopOnly";
}

function normalizeWorkspaceFilterMode(
  mode: ClaudeMigrationWorkspaceFilterMode,
  workspacePath: string | null,
): ClaudeMigrationWorkspaceFilterMode {
  if (mode === "current" && !workspacePath) {
    return "all";
  }

  return mode;
}

export function useClaudeSessionMigration(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const zcodeTaskService = useZCodeTaskService(
    params.workspacePath ?? undefined,
    undefined,
    params.workspaceIdentity,
  );
  const tabStoreApi = useTabStoreApi();
  const [workspaceFilterModeState, setWorkspaceFilterModeState] =
    useState<ClaudeMigrationWorkspaceFilterMode>("all");
  const [range, setRange] = useState<ClaudeMigrationRange>("30d");
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [candidates, setCandidates] = useState<ZCodeImportableSessionCandidate[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] = useState<ZCodeImportSessionsResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  // importSessions 的入参 sessionId 来自扫描时的候选；导入时按 provider 拆分调用，
  // 这里用 ref 读取最新候选映射，避免闭包拿到过期列表。
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const workspaceFilterMode = useMemo(
    () => normalizeWorkspaceFilterMode(workspaceFilterModeState, params.workspacePath),
    [workspaceFilterModeState, params.workspacePath],
  );

  const effectiveWorkspacePath = useMemo(
    () => (workspaceFilterMode === "current" ? (params.workspacePath ?? undefined) : undefined),
    [workspaceFilterMode, params.workspacePath],
  );
  const effectiveWorkspaceIdentity = useMemo(
    () =>
      workspaceFilterMode === "current" ? params.workspaceIdentity?.trim() || undefined : undefined,
    [params.workspaceIdentity, workspaceFilterMode],
  );

  const supportState = useMemo<ClaudeSessionMigrationSupportState>(() => {
    // 关键业务逻辑：Claude 原生历史迁移读取的是“当前机器上的 ~/.claude/projects”。
    // 因此这里只拦 web 场景；workspace 现在只是可选筛选条件，不再决定能力是否可用。
    if (!params.isDesktop) {
      return {
        supported: false,
        reason: "desktopOnly",
      };
    }

    return {
      supported: true,
    };
  }, [params.isDesktop]);

  const scanLimit = useMemo(() => resolveClaudeMigrationScanLimit(limitInput), [limitInput]);

  const setWorkspaceFilterMode = useCallback(
    (mode: ClaudeMigrationWorkspaceFilterMode) => {
      setWorkspaceFilterModeState(normalizeWorkspaceFilterMode(mode, params.workspacePath));
    },
    [params.workspacePath],
  );

  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((previous) => {
      if (previous.includes(sessionId)) {
        return previous.filter((current) => current !== sessionId);
      }

      return [...previous, sessionId];
    });
  }, []);

  const selectAllSessions = useCallback(() => {
    setSelectedSessionIds(candidates.map((candidate) => candidate.sessionId));
  }, [candidates]);

  const clearSelectedSessions = useCallback(() => {
    setSelectedSessionIds([]);
  }, []);

  const scan = useCallback(async () => {
    if (!supportState.supported) {
      return;
    }

    setIsScanning(true);
    setScanError(null);

    try {
      logger.info(
        `[Migration] 开始扫描原生历史（Claude/Codex） workspaceFilter=${effectiveWorkspacePath ?? "all"} range=${range} limit=${scanLimit ?? "unlimited"}`,
      );
      const scanParams = {
        workspacePath: effectiveWorkspacePath,
        ...(effectiveWorkspaceIdentity ? { workspaceIdentity: effectiveWorkspaceIdentity } : {}),
        modifiedSince: resolveModifiedSince(range),
        ...(scanLimit === undefined ? {} : { limit: scanLimit }),
      };
      // Codex 扫描失败（如旧 host 进程没有该方法）不能阻断向导：降级为仅 Claude 并记 warn。
      const [claudeOutcome, codexOutcome] = await Promise.allSettled([
        zcodeTaskService.scanImportableClaudeSessions(scanParams),
        zcodeTaskService.scanImportableCodexSessions(scanParams),
      ]);
      if (claudeOutcome.status === "rejected") {
        throw claudeOutcome.reason;
      }
      if (codexOutcome.status === "rejected") {
        logger.warn("[Migration] 扫描 Codex 原生历史失败（降级为仅 Claude）", codexOutcome.reason);
      }
      const nextCandidates = [
        ...claudeOutcome.value,
        ...(codexOutcome.status === "fulfilled" ? codexOutcome.value : []),
      ].sort((left, right) => right.updatedAt - left.updatedAt);
      setCandidates(nextCandidates);
      // 关键业务逻辑：重扫后只保留仍然可见的勾选项。
      // 这样用户调筛选条件或刷新结果时，不会把已经不在当前列表里的旧 session 混进导入请求。
      setSelectedSessionIds((previous) =>
        previous.filter((sessionId) =>
          nextCandidates.some((candidate) => candidate.sessionId === sessionId),
        ),
      );
      logger.info(
        `[Migration] 原生历史扫描完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} count=${nextCandidates.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Migration] 扫描 Claude 原生历史失败", error);
      setScanError(message);
    } finally {
      setIsScanning(false);
    }
  }, [
    zcodeTaskService,
    effectiveWorkspaceIdentity,
    effectiveWorkspacePath,
    range,
    scanLimit,
    supportState.supported,
  ]);

  const importSessions = useCallback(
    async (sessionIds: string[]) => {
      if (!supportState.supported || sessionIds.length === 0) {
        return null;
      }

      setIsImporting(true);
      setImportError(null);

      try {
        logger.info(
          `[Migration] 开始导入原生历史（Claude/Codex） workspaceFilter=${effectiveWorkspacePath ?? "all"} selected=${sessionIds.length}`,
        );
        // 候选携带 provider（claude/codex），按 provider 拆分调用各自导入服务后合并结果。
        const providerBySessionId = new Map(
          candidatesRef.current.map((candidate) => [candidate.sessionId, candidate.provider]),
        );
        const claudeSessionIds = sessionIds.filter(
          (sessionId) => providerBySessionId.get(sessionId) !== "codex",
        );
        const codexSessionIds = sessionIds.filter(
          (sessionId) => providerBySessionId.get(sessionId) === "codex",
        );
        const importParams = {
          workspacePath: effectiveWorkspacePath,
          ...(effectiveWorkspaceIdentity ? { workspaceIdentity: effectiveWorkspaceIdentity } : {}),
        };
        const [claudeOutcome, codexOutcome] = await Promise.allSettled([
          claudeSessionIds.length > 0
            ? zcodeTaskService.importClaudeSessions({
                ...importParams,
                sessionIds: claudeSessionIds,
              })
            : Promise.resolve(null),
          codexSessionIds.length > 0
            ? zcodeTaskService.importCodexSessions({
                ...importParams,
                sessionIds: codexSessionIds,
              })
            : Promise.resolve(null),
        ]);
        const partialResult: ZCodeImportSessionsResult = {
          imported: [],
          skipped: [],
          failed: [],
        };
        for (const outcome of [claudeOutcome, codexOutcome]) {
          if (outcome.status === "fulfilled" && outcome.value) {
            partialResult.imported.push(...outcome.value.imported);
            partialResult.skipped.push(...outcome.value.skipped);
            partialResult.failed.push(...outcome.value.failed);
          }
        }
        const rejectedOutcome = [claudeOutcome, codexOutcome].find(
          (outcome) => outcome.status === "rejected",
        );
        if (rejectedOutcome?.status === "rejected") {
          const message =
            rejectedOutcome.reason instanceof Error
              ? rejectedOutcome.reason.message
              : String(rejectedOutcome.reason);
          logger.error("[Migration] 导入原生历史失败（部分来源）", rejectedOutcome.reason);
          setImportError(message);
        }
        const result = partialResult;
        setLastImportResult(result);
        const handledSessionIds = new Set([
          ...result.imported.map((item) => item.sessionId),
          ...result.skipped.map((item) => item.sessionId),
          ...result.failed.map((item) => item.sessionId),
        ]);
        setSelectedSessionIds((previous) =>
          previous.filter((sessionId) => !handledSessionIds.has(sessionId)),
        );
        if (result.imported.length > 0) {
          const importedWorkspacePaths = new Set(result.imported.map((item) => item.workspacePath));
          // 导入之前通过 bumpTaskListVersion 让各处任务列表整轮重查，
          // 但这里真正需要的只是把受影响 workspace 的查询结果失效并重新拉取。
          // 改成局部失效后，仍然能让新导入任务出现在侧边栏，同时避免把无关 workspace 一起带着刷新。
          const importedWorkspaceScopes = result.imported.map((item) => ({
            workspacePath: item.workspacePath,
          }));
          for (const workspacePath of importedWorkspacePaths) {
            tabStoreApi.getState().ensureWorkspaceTab(workspacePath);
          }
          invalidateTaskQueryCacheByScopes(importedWorkspaceScopes);
        }
        logger.info(
          `[Migration] 原生历史导入完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Migration] 导入原生历史失败", error);
        setImportError(message);
        return null;
      } finally {
        setIsImporting(false);
      }
    },
    [
      zcodeTaskService,
      effectiveWorkspaceIdentity,
      effectiveWorkspacePath,
      supportState.supported,
      tabStoreApi,
    ],
  );

  const importSelectedSessions = useCallback(async () => {
    return importSessions(selectedSessionIds);
  }, [importSessions, selectedSessionIds]);

  return {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter: params.workspacePath !== null,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount: selectedSessionIds.length,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSessions,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  };
}
