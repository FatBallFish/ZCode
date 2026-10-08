/**
 * 设置 · Git 工作树管理页（specs/desktop/worktrees.md）。
 *
 * 上半区：4 项配置（根目录 / fetch / 自动清理 / 上限，AppSettings.worktreeConfig，
 * 写后回读校验沿用 external CDP 先例）；下半区：按根项目分组的工作树列表
 * （组头项目名+根路径+刷新；行内路径/状态/关联会话 + 「在此工作树中新建聊天」「删除」）。
 * 删除为两击确认；脏树先提示再出现「强制删除」；运行中进程直接拒绝。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  createDefaultWorktreeConfig,
  WORKTREE_AUTO_PRUNE_LIMIT_MAX,
  WORKTREE_AUTO_PRUNE_LIMIT_MIN,
  type WorktreeListResult,
  type WorktreeOverviewItem,
  type WorktreeRootGroup,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { WorktreeRowCard } from "@/settings/WorktreeRowCard.js";
import { useWorktreeStore } from "@/store/worktreeStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorktreesSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const worktreeService = services.worktreeService;
  const selectDirectory = useSelectDirectory();
  const { settings, update } = useSettings();
  const tabStore = useTabStoreApi();
  const refreshRegistry = useWorktreeStore((state) => state.refreshRegistry);
  const startDraft = useZCodeSessionStore((state) => state.startDraft);

  const [list, setList] = useState<WorktreeListResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [forcePath, setForcePath] = useState<string | null>(null);
  const listRequestIdRef = useRef(0);

  const config = useMemo(
    () => settings?.worktreeConfig ?? createDefaultWorktreeConfig("~/.mikiko/worktrees"),
    [settings?.worktreeConfig],
  );
  const [rootDirDraft, setRootDirDraft] = useState(config.rootDir);
  useEffect(() => {
    setRootDirDraft(config.rootDir);
  }, [config.rootDir]);

  const refreshList = useCallback(async (): Promise<WorktreeListResult | null> => {
    if (!worktreeService) return null;
    const requestId = ++listRequestIdRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const result = await worktreeService.list();
      if (listRequestIdRef.current !== requestId) return null;
      setList(result);
      setListLoading(false);
      void refreshRegistry(worktreeService);
      return result;
    } catch (error) {
      if (listRequestIdRef.current !== requestId) return null;
      const message = getErrorMessage(error);
      // host 未注册 worktree channel（版本过旧）：给出重启指引而不是裸 RPC 报错。
      setListError(
        /timed out|Unknown channel/i.test(message)
          ? intl.formatMessage({ id: "settings.worktrees.hostOutdated" })
          : message,
      );
      setListLoading(false);
      return null;
    }
  }, [intl, refreshRegistry, worktreeService]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const handleSaveConfig = useCallback(
    async (patch: Partial<typeof config>) => {
      const next = { ...config, ...patch };
      await update({ worktreeConfig: next });
      // 写后回读：改 appSettingsSchema 后旧 host 会剥离新字段，必须完全重启（external CDP 先例）。
      const readBack = (await services.settingService.get()).worktreeConfig;
      if (JSON.stringify(readBack) !== JSON.stringify(next)) {
        toast(intl.formatMessage({ id: "settings.worktrees.staleHostWarning" }), {
          variant: "warning",
        });
      }
    },
    [config, intl, services.settingService, update],
  );

  const handleStartChatInWorktree = useCallback(
    (worktreePath: string) => {
      tabStore.getState().ensureWorkspaceTab(worktreePath);
      tabStore.getState().activateTabByPath(worktreePath);
      startDraft(worktreePath, undefined, undefined, { createSource: "project" });
    },
    [startDraft, tabStore],
  );

  const handleRemove = useCallback(
    async (item: WorktreeOverviewItem, force: boolean) => {
      if (!worktreeService) return;
      setRemovingPath(item.entry.worktreePath);
      try {
        const result = await worktreeService.remove({
          worktreePath: item.entry.worktreePath,
          ...(force ? { force: true } : {}),
        });
        if (result.removed) {
          setConfirmPath(null);
          setForcePath(null);
          toast(
            intl.formatMessage(
              { id: "settings.worktrees.removed" },
              { count: result.removedSessionCount },
            ),
          );
          await refreshList();
        } else if (result.blockReason === "dirty") {
          setForcePath(item.entry.worktreePath);
          toast(intl.formatMessage({ id: "settings.worktrees.removeDirty" }), {
            variant: "warning",
          });
        } else if (result.blockReason === "process-alive") {
          // 空闲会话进程挡住删除：亮出「强制删除」（会先停止该空闲进程再删）；
          // 若有任务真正在跑则维持拦截提示。
          setForcePath(item.entry.worktreePath);
          toast(
            result.message === "a task is still running in this worktree"
              ? intl.formatMessage({ id: "settings.worktrees.removeRunningTask" })
              : intl.formatMessage({ id: "settings.worktrees.removeRunningIdle" }),
            { variant: "warning" },
          );
        } else {
          toast(result.message ?? intl.formatMessage({ id: "settings.worktrees.removeFailed" }), {
            variant: "warning",
          });
        }
      } catch (error) {
        logger.warn("[Worktrees] 删除失败", { error });
        toast(getErrorMessage(error), { variant: "warning" });
      } finally {
        setRemovingPath(null);
      }
    },
    [intl, refreshList, worktreeService],
  );

  if (!worktreeService) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.worktrees.unavailable" })}
          description={intl.formatMessage({ id: "settings.worktrees.unavailableHint" })}
          control={<span />}
        />
      </SettingsGroupCard>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.worktrees.rootDir" })}
          description={intl.formatMessage({ id: "settings.worktrees.rootDirHint" })}
          controlLayout="wide"
          control={
            <div className="flex w-full items-center justify-end gap-2">
              <Input
                value={rootDirDraft}
                onChange={(event) => setRootDirDraft(event.target.value)}
                onBlur={() => {
                  if (rootDirDraft.trim() && rootDirDraft.trim() !== config.rootDir) {
                    void handleSaveConfig({ rootDir: rootDirDraft.trim() });
                  }
                }}
                className="h-8 w-full min-w-0 flex-1"
                spellCheck={false}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={async () => {
                  const dir = await selectDirectory();
                  if (dir) {
                    setRootDirDraft(dir);
                    await handleSaveConfig({ rootDir: dir });
                  }
                }}
              >
                {intl.formatMessage({ id: "settings.worktrees.chooseDir" })}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.worktrees.fetchBeforeCreate" })}
          description={intl.formatMessage({ id: "settings.worktrees.fetchBeforeCreateHint" })}
          control={
            <Switch
              checked={config.fetchBeforeCreate}
              onCheckedChange={(checked) => void handleSaveConfig({ fetchBeforeCreate: checked })}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.worktrees.autoPrune" })}
          description={intl.formatMessage({ id: "settings.worktrees.autoPruneHint" })}
          controlLayout="wide"
          control={
            <div className="flex w-full items-center justify-end gap-3">
              <Switch
                checked={config.autoPruneEnabled}
                onCheckedChange={(checked) => void handleSaveConfig({ autoPruneEnabled: checked })}
              />
              {config.autoPruneEnabled ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={config.autoPruneLimit}
                    min={WORKTREE_AUTO_PRUNE_LIMIT_MIN}
                    max={WORKTREE_AUTO_PRUNE_LIMIT_MAX}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      if (Number.isFinite(parsed)) {
                        void handleSaveConfig({
                          autoPruneLimit: Math.min(
                            WORKTREE_AUTO_PRUNE_LIMIT_MAX,
                            Math.max(WORKTREE_AUTO_PRUNE_LIMIT_MIN, parsed),
                          ),
                        });
                      }
                    }}
                    className="h-8 w-20"
                  />
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.worktrees.autoPruneLimitSuffix" })}
                  </span>
                </div>
              ) : null}
            </div>
          }
        />
      </SettingsGroupCard>

      {listError ? (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-ui-sm text-error">
          {listError}
        </div>
      ) : null}

      {listLoading && !list ? (
        <div className="flex items-center gap-2 px-1 text-ui-sm text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {intl.formatMessage({ id: "settings.worktrees.loading" })}
        </div>
      ) : null}

      {list?.groups.length === 0 && !listLoading ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.worktrees.empty" })}
        </div>
      ) : null}

      {list?.groups.map((group: WorktreeRootGroup) => (
        <div key={group.rootWorkspacePath} className="flex flex-col gap-2">
          <SettingsResourceGroupHeader
            title={group.repoName}
            count={group.worktrees.length}
            actions={
              <div className="flex items-center gap-2">
                <span
                  className="max-w-[320px] truncate text-ui-sm text-foreground-subtle"
                  title={group.rootWorkspacePath}
                >
                  {group.rootWorkspacePath}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void refreshList()}
                  aria-label={intl.formatMessage({ id: "settings.worktrees.refresh" })}
                >
                  <RefreshCw className={listLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                </Button>
              </div>
            }
          />
          <SettingsResourceList
            items={group.worktrees}
            getKey={(item) => item.entry.worktreePath}
            renderItem={(item) => (
              <WorktreeRowCard
                item={item}
                removing={removingPath === item.entry.worktreePath}
                confirmArmed={confirmPath === item.entry.worktreePath}
                forceArmed={forcePath === item.entry.worktreePath}
                onArmConfirm={() => {
                  setConfirmPath(item.entry.worktreePath);
                  setForcePath(null);
                }}
                onCancelConfirm={() => {
                  setConfirmPath(null);
                  setForcePath(null);
                }}
                onStartChat={() => handleStartChatInWorktree(item.entry.worktreePath)}
                onRemove={(force) => void handleRemove(item, force)}
              />
            )}
          />
        </div>
      ))}
    </div>
  );
}
