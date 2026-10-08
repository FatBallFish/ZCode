/**
 * 设置 · Worktrees 页的单行工作树卡片（specs/desktop/worktrees.md）。
 * 从 WorktreesSection 拆出以守住 max-lines；纯展示 + 回调，无自身状态。
 */
import { GitBranch, Loader2, Trash2 } from "lucide-react";
import type { WorktreeOverviewItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { worktreeShortId } from "@/store/worktreeStore.js";

export function WorktreeRowCard({
  item,
  removing,
  confirmArmed,
  forceArmed,
  onArmConfirm,
  onCancelConfirm,
  onStartChat,
  onRemove,
}: {
  item: WorktreeOverviewItem;
  removing: boolean;
  confirmArmed: boolean;
  forceArmed: boolean;
  onArmConfirm: () => void;
  onCancelConfirm: () => void;
  onStartChat: () => void;
  onRemove: (force: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const shortId = worktreeShortId(item.entry.id);
  const statusLabel =
    item.diskStatus === "ready"
      ? item.dirtyFileCount !== null && item.dirtyFileCount > 0
        ? intl.formatMessage({ id: "settings.worktrees.dirty" }, { count: item.dirtyFileCount })
        : intl.formatMessage({ id: "settings.worktrees.clean" })
      : item.diskStatus === "missing"
        ? intl.formatMessage({ id: "settings.worktrees.missing" })
        : intl.formatMessage({ id: "settings.worktrees.pruned" });

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
        <span className="font-mono text-ui-sm text-foreground" title={item.entry.worktreePath}>
          {shortId}
        </span>
        <span className="text-ui-sm text-foreground-subtle" title={item.entry.worktreePath}>
          {item.entry.worktreePath}
        </span>
        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
          {item.entry.ref}
          {item.headShortSha ? ` · ${item.headShortSha}` : ""}
        </span>
        <span
          className={
            item.diskStatus === "ready"
              ? "text-ui-xs text-foreground-subtle"
              : "text-ui-xs text-warning"
          }
        >
          {statusLabel}
        </span>
      </div>
      {item.sessions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-5">
          {item.sessions.map((session) => (
            <span
              key={session.taskId}
              className="max-w-[240px] truncate rounded bg-surface-raised px-1.5 py-0.5 text-ui-xs text-foreground-secondary"
              title={session.title}
            >
              {session.title}
            </span>
          ))}
        </div>
      ) : (
        <div className="pl-5 text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.worktrees.noSessions" })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pl-5">
        <Button
          variant="outline"
          size="sm"
          onClick={onStartChat}
          disabled={item.diskStatus === "missing"}
        >
          {intl.formatMessage({ id: "settings.worktrees.startChat" })}
        </Button>
        {removing ? (
          <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle" />
        ) : confirmArmed && (forceArmed || item.diskStatus === "missing") ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancelConfirm}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onRemove(true)}>
              {intl.formatMessage({ id: "settings.worktrees.forceRemove" })}
            </Button>
          </>
        ) : confirmArmed ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancelConfirm}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onRemove(false)}>
              {intl.formatMessage({ id: "settings.worktrees.confirmRemove" })}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onArmConfirm}
            aria-label={intl.formatMessage({ id: "settings.worktrees.remove" })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
