/**
 * 设置 · 已归档页的单行会话卡片（从 ArchivedSessionsSection 拆出以守住 max-lines）。
 * worktree 会话带分支标识；不可取消归档（工作树已移除）时仅展示状态与删除。
 */
import { ArchiveRestore, GitBranch, Trash2 } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { worktreeShortId } from "@/store/worktreeStore.js";

export function ArchivedTaskRowCard({
  task,
  worktreeInfo,
  unarchivable,
  confirmArmed,
  onArmConfirm,
  onCancelConfirm,
  onUnarchive,
  onDelete,
}: {
  task: ZCodeTaskMeta;
  worktreeInfo: { rootWorkspacePath: string; diskStatus: string; branch: string | null } | null;
  unarchivable: boolean;
  confirmArmed: boolean;
  onArmConfirm: () => void;
  onCancelConfirm: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const { intl } = useZCodeIntl();
  // 2026-10-15 分支展示规则：绑定分支展示分支名；游离/注册表已删（info 为 null 或
  // branch null）回落短 id（路径末段前 4 位，注册表删除后仍可显示）。
  const worktreeIdentity = worktreeInfo?.branch ?? worktreeShortId(task.workspacePath);
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {worktreeInfo ? (
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
        ) : null}
        <span
          className="min-w-0 max-w-[420px] truncate text-ui-sm text-foreground"
          title={task.title}
        >
          {task.title}
        </span>
        {worktreeInfo ? (
          <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
            {worktreeIdentity}
          </span>
        ) : null}
        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
          {formatTaskRelativeTime(task.updatedAt, intl)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {unarchivable ? (
          <Button variant="outline" size="sm" onClick={onUnarchive}>
            <ArchiveRestore className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "settings.archived.unarchive" })}
          </Button>
        ) : (
          <span
            className="px-1 text-ui-xs text-foreground-subtlest"
            title={intl.formatMessage({ id: "settings.archived.worktreeGone" })}
          >
            {intl.formatMessage({ id: "settings.archived.worktreeGoneShort" })}
          </span>
        )}
        {confirmArmed ? (
          <>
            <Button variant="ghost" size="sm" onClick={onCancelConfirm}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button variant="destructive" size="sm" onClick={onDelete}>
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onArmConfirm}
            aria-label={intl.formatMessage({ id: "settings.archived.delete" })}
          >
            <Trash2 className="h-4 w-4 text-foreground-subtle" />
          </Button>
        )}
      </div>
    </div>
  );
}
