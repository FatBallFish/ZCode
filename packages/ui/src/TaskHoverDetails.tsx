import type { ReactNode } from "react";
import { Cloud, Folder, GitBranch } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

type TaskHoverDetailsIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
};

/**
 * 会话行 hover 详情卡（自测反馈）：会话名称 / 所属项目 / 工作位置 / 最近会话模糊时间。
 * 纯内容组件——Tooltip 的挂载与降级策略（overlay 拖拽时禁用等）由各调用方自己的
 * Tooltip 包装负责；默认视图（TaskListItem）与分组视图（task-row）共用。
 */
export function TaskHoverDetailsContent({
  task,
  projectLabel,
  rootWorkspacePath,
  remoteSessionId,
  isWorktree,
  intl,
  extraLine,
}: {
  task: ZCodeTaskMeta;
  /** 项目显示名（workspace label / worktree 短标签）。 */
  projectLabel: string;
  /** 所属项目根路径；task.workspacePath 与之不同即 worktree 会话（换 GitBranch 图标）。 */
  rootWorkspacePath?: string;
  remoteSessionId?: string;
  /** 分组视图已有 worktree registry 判定，直接传入优先于路径比较。 */
  isWorktree?: boolean;
  intl: TaskHoverDetailsIntl;
  /** 追加信息行（分组视图复用原 ±行数 变更摘要）。 */
  extraLine?: ReactNode;
}) {
  const title =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const isWorktreeSession = Boolean(
    isWorktree ??
    (rootWorkspacePath && task.workspacePath && task.workspacePath !== rootWorkspacePath),
  );
  const recentLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const locationIcon = remoteSessionId ? (
    <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
  ) : isWorktreeSession ? (
    <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
  ) : (
    <Folder aria-hidden="true" className="size-3.5 shrink-0" />
  );

  return (
    <div className="flex w-72 max-w-72 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {locationIcon}
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-tooltip-foreground">
          {title}
        </span>
        <span className="shrink-0 text-ui-xs tabular-nums text-tooltip-foreground/60">
          {recentLabel}
        </span>
      </div>
      <div className="flex flex-col gap-1 text-ui-xs/relaxed text-tooltip-foreground/90">
        <HoverField label={intl.formatMessage({ id: "taskList.hover.project" })}>
          <span className="break-all">{projectLabel}</span>
        </HoverField>
        <HoverField label={intl.formatMessage({ id: "taskList.hover.location" })}>
          <span className="break-all font-mono">{task.workspacePath}</span>
        </HoverField>
        <HoverField label={intl.formatMessage({ id: "taskList.hover.recent" })}>
          <span className="tabular-nums">{recentLabel}</span>
        </HoverField>
        {extraLine}
      </div>
    </div>
  );
}

/** extraLine 复用的字段行（分组视图的 ±行数 变更摘要等）。 */
export function TaskHoverField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-10 shrink-0 text-tooltip-foreground/55">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function HoverField({ label, children }: { label: string; children: ReactNode }) {
  return <TaskHoverField label={label}>{children}</TaskHoverField>;
}
