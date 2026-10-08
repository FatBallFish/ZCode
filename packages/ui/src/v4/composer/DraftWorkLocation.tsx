/**
 * 草稿态「工作位置」chip（specs/desktop/worktrees.md）。
 *
 * 三态（worktreeStore.draftLocation，按根 workspaceKey）：
 * - local：原样渲染 GitBranchSwitcher（分支切换语义不变）；
 * - new-worktree：起始 ref 选择（不 checkout 根工作区；缺省远程默认分支）；
 * - existing-worktree：锁定展示「现有工作树 · 短id / 分离头指针」。
 * 在 worktree workspace 内的草稿恒为锁定态（registry 命中当前路径）。
 * 首发分流在 SessionPane（handleSendText 拦截），本组件只管选择状态。
 */
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  CloudDownload,
  GitBranch,
  GitBranchPlus,
  Laptop,
  Loader2,
} from "lucide-react";
import type { GitRepositorySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { logger } from "@/logger.js";
import {
  DEFAULT_DRAFT_LOCATION,
  useWorktreeStore,
  worktreeShortId,
  type DraftWorkLocationMode,
} from "@/store/worktreeStore.js";

interface WorktreeOption {
  key: string;
  mode: DraftWorkLocationMode;
  label: string;
  worktreePath?: string;
}

export function DraftWorkLocation({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  dirtyFileCount,
  onRefreshGit,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const worktreeService = services.worktreeService;
  const registryEntries = useWorktreeStore((state) => state.registryEntries);
  const rootKey = workspaceIdentity?.trim() || workspacePath;
  // selector 的 fallback 必须是稳定引用：字面量会在每次 getSnapshot 产生新对象，
  // zustand v5 + useSyncExternalStore 会陷入快照循环导致草稿页崩溃。
  const location = useWorktreeStore(
    (state) => state.draftLocationByRootKey[rootKey] ?? DEFAULT_DRAFT_LOCATION,
  );
  const setDraftLocation = useWorktreeStore((state) => state.setDraftLocation);

  // 当前草稿 workspace 本身是注册工作树 → 锁定态（不受 draftLocation 影响）。
  const currentWorktreeEntry = useMemo(
    () => registryEntries.find((entry) => entry.worktreePath === workspacePath) ?? null,
    [registryEntries, workspacePath],
  );

  const rootWorktrees = useMemo(
    () =>
      registryEntries
        .filter((entry) => entry.rootWorkspacePath === workspacePath)
        .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
    [registryEntries, workspacePath],
  );

  const isLocalRepo =
    !workspaceIdentity && gitSummary.isGitAvailable && gitSummary.isRepository === true;

  // worktree 能力不可用（旧 wire / 远程 workspace / 非 git 仓库）→ 完全回落原分支 chip。
  const worktreeCapable = Boolean(worktreeService) && isLocalRepo;

  const branchSwitcher = useMemo(
    () => (
      <GitBranchSwitcher
        workspacePath={workspacePath}
        gitSummary={gitSummary}
        dirtyFileCount={dirtyFileCount}
        onRefreshGit={onRefreshGit}
        className="px-0 pt-0"
        popoverClassName="w-72"
        branchListClassName="max-h-48"
        // 输入框区域在底部，锁上方弹出（与既有草稿 header 分支 chip 一致）。
        avoidPopoverCollisions={false}
      />
    ),
    [dirtyFileCount, gitSummary, onRefreshGit, workspacePath],
  );

  if (currentWorktreeEntry) {
    // worktree workspace 草稿：两枚只读 chip（Codex 语义：现有工作树 + 分离头指针）。
    return (
      <div className={cn("flex items-center gap-1", className)}>
        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-ui-sm text-foreground-secondary">
          <GitBranch className="h-3.5 w-3.5 text-foreground-subtle" />
          {intl.formatMessage({ id: "chat.workLocation.existingWorktree" })}
          <span className="font-mono text-ui-xs text-foreground-subtle">
            {worktreeShortId(currentWorktreeEntry.id)}
          </span>
        </span>
        <span className="inline-flex h-7 items-center rounded-md border border-border bg-surface px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "git.head.detached" })}
        </span>
      </div>
    );
  }

  if (!worktreeCapable) {
    return branchSwitcher;
  }

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <LocationSelector
        rootKey={rootKey}
        mode={location.mode}
        selectedWorktreePath={location.worktreePath}
        rootWorktrees={rootWorktrees}
        onSelect={(next) => setDraftLocation(rootKey, next)}
      />
      {location.mode === "local" ? (
        branchSwitcher
      ) : location.mode === "new-worktree" ? (
        <RefPicker
          workspacePath={workspacePath}
          selectedRef={location.ref}
          onSelect={(ref) => setDraftLocation(rootKey, { mode: "new-worktree", ref })}
        />
      ) : (
        <span className="inline-flex h-7 items-center rounded-md border border-border bg-surface px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "git.head.detached" })}
        </span>
      )}
    </div>
  );
}

function LocationSelector({
  rootKey,
  mode,
  selectedWorktreePath,
  rootWorktrees,
  onSelect,
}: {
  rootKey: string;
  mode: DraftWorkLocationMode;
  selectedWorktreePath?: string;
  rootWorktrees: Array<{ id: string; worktreePath: string }>;
  onSelect: (location: {
    mode: DraftWorkLocationMode;
    ref?: string;
    worktreePath?: string;
  }) => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);

  const options = useMemo<WorktreeOption[]>(() => {
    const base: WorktreeOption[] = [
      { key: "local", mode: "local", label: intl.formatMessage({ id: "chat.workLocation.local" }) },
      {
        key: "new-worktree",
        mode: "new-worktree",
        label: intl.formatMessage({ id: "chat.workLocation.newWorktree" }),
      },
    ];
    for (const entry of rootWorktrees) {
      base.push({
        key: `existing:${entry.worktreePath}`,
        mode: "existing-worktree",
        label: `${intl.formatMessage({ id: "chat.workLocation.existingWorktree" })} · ${worktreeShortId(entry.id)}`,
        worktreePath: entry.worktreePath,
      });
    }
    return base;
  }, [intl, rootWorktrees]);

  // 触发器用 icon 替代「工作位置」前缀文案（本地=Laptop / 新建=GitBranchPlus / 现有=GitBranch），
  // 当前值文案保留展示；注意不要把 Tooltip 包进 PopoverTrigger asChild——Slot 无法把
  // 事件/ref 转发到 Provider 型子组件，会导致菜单点不开。
  const TriggerIcon =
    mode === "local" ? Laptop : mode === "new-worktree" ? GitBranchPlus : GitBranch;

  const triggerLabel =
    mode === "local"
      ? intl.formatMessage({ id: "chat.workLocation.local" })
      : mode === "new-worktree"
        ? intl.formatMessage({ id: "chat.workLocation.newWorktree" })
        : intl.formatMessage({ id: "chat.workLocation.existingWorktree" });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-ui-sm"
          aria-label={intl.formatMessage({ id: "chat.workLocation.label" })}
        >
          <TriggerIcon className="h-4 w-4 shrink-0 text-foreground-subtle" />
          {triggerLabel}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        avoidCollisions={false}
        className="w-64 p-1"
        // rootKey 只用于稳定弹出层身份，不参与渲染。
        data-worktree-location-root={rootKey}
      >
        <div className="flex flex-col">
          {options.map((option) => {
            const OptionIcon =
              option.mode === "local"
                ? Laptop
                : option.mode === "new-worktree"
                  ? GitBranchPlus
                  : GitBranch;
            const optionSelected =
              option.mode !== "existing-worktree"
                ? option.mode === mode
                : mode === "existing-worktree" && option.worktreePath === selectedWorktreePath;
            return (
              <button
                key={option.key}
                type="button"
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm transition-colors hover:bg-surface-raised",
                  optionSelected && "text-foreground font-medium",
                )}
                onClick={() => {
                  setOpen(false);
                  if (option.mode === "local") {
                    onSelect({ mode: "local" });
                  } else if (option.mode === "new-worktree") {
                    onSelect({ mode: "new-worktree" });
                  } else {
                    onSelect({
                      mode: "existing-worktree",
                      worktreePath: option.worktreePath,
                    });
                  }
                }}
              >
                <OptionIcon className="h-4 w-4 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {optionSelected ? <Check className="h-3.5 w-3.5 shrink-0 text-foreground" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** new-worktree 模式的起始 ref 选择：本地分支 + 远程默认分支（不 checkout）。 */
function RefPicker({
  workspacePath,
  selectedRef,
  onSelect,
}: {
  workspacePath: string;
  selectedRef?: string;
  onSelect: (ref: string | undefined) => void;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || branches !== null || !services.gitService) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    services.gitService
      .getLocalBranches({ workspacePath })
      .then((result) => {
        if (cancelled) return;
        setBranches(result.branches.map((branch) => branch.name));
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn("[DraftWorkLocation] 分支列表加载失败", { error });
        setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branches, open, services.gitService, workspacePath]);

  const triggerLabel = selectedRef
    ? selectedRef
    : intl.formatMessage({ id: "chat.workLocation.remoteDefault" });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 font-mono text-ui-sm">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          <span className="font-sans text-foreground-subtle">
            {intl.formatMessage({ id: "chat.workLocation.refPrefix" })}
          </span>
          {triggerLabel}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" avoidCollisions={false} className="w-64 p-1">
        <div className="flex max-h-56 flex-col overflow-y-auto">
          <button
            type="button"
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm transition-colors hover:bg-surface-raised",
              !selectedRef && "text-foreground font-medium",
            )}
            onClick={() => {
              setOpen(false);
              onSelect(undefined);
            }}
          >
            <CloudDownload className="h-4 w-4 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage({ id: "chat.workLocation.remoteDefault" })}
            </span>
            {!selectedRef ? <Check className="h-3.5 w-3.5 shrink-0 text-foreground" /> : null}
          </button>
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-foreground-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {intl.formatMessage({ id: "git.branchSwitcher.loading" })}
            </div>
          ) : (
            (branches ?? []).map((branchName) => (
              <button
                key={branchName}
                type="button"
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-ui-sm transition-colors hover:bg-surface-raised",
                  selectedRef === branchName && "text-foreground font-medium",
                )}
                onClick={() => {
                  setOpen(false);
                  onSelect(branchName);
                }}
              >
                <GitBranch className="h-4 w-4 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate">{branchName}</span>
                {selectedRef === branchName ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
