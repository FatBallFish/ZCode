import { useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import type { SessionStatsState } from "@zcode/shared/zcode-protocol-v4";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";

/**
 * 会话统计胶囊 + 弹出卡片（specs/ui/session-stats.md）。
 * 数据唯一来源：v4 snapshot.stats（CLI 投影聚合；旧 CLI 无该字段时整体隐藏）。
 * 胶囊显示轮次/步数与实时（流式中）或会话平均输出速度；卡片四行：
 * 模型用时 / 工具调用用时 / 首 token 平均（TTFT）/ 输出速度（TPS）。
 */
export function ChatSessionStats({ sessionStats }: { sessionStats: SessionStatsState | null }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);

  const averageTps = useMemo(() => {
    if (!sessionStats || sessionStats.generationDurationMs <= 0) return null;
    return (sessionStats.outputTokens / sessionStats.generationDurationMs) * 1000;
  }, [sessionStats]);

  if (!sessionStats) return null;

  // 流式中显示实时滚动估算；空闲回退会话平均；两者皆无则只显示轮次/步数。
  const displayedTps = sessionStats.liveTokensPerSecond ?? averageTps;

  const capsuleLabel =
    displayedTps === null
      ? intl.formatMessage(
          { id: "chat.sessionStats.turnsSteps" },
          { turns: String(sessionStats.turnCount), steps: String(sessionStats.stepCount) },
        )
      : intl.formatMessage(
          { id: "chat.sessionStats.capsule" },
          {
            turns: String(sessionStats.turnCount),
            steps: String(sessionStats.stepCount),
            tps: String(Math.round(displayedTps)),
          },
        );

  const rows: { key: string; labelId: string; value: string }[] = [
    {
      key: "modelDuration",
      labelId: "chat.sessionStats.modelDuration",
      value: formatBackgroundTaskElapsedLabel(sessionStats.modelDurationMs, intl.formatMessage),
    },
    {
      key: "toolDuration",
      labelId: "chat.sessionStats.toolDuration",
      value: formatBackgroundTaskElapsedLabel(sessionStats.toolDurationMs, intl.formatMessage),
    },
    {
      key: "ttft",
      labelId: "chat.sessionStats.ttft",
      value:
        sessionStats.ttftAvgMs === null
          ? "—"
          : formatBackgroundTaskElapsedLabel(sessionStats.ttftAvgMs, intl.formatMessage),
    },
    {
      key: "tps",
      labelId: "chat.sessionStats.tps",
      value:
        averageTps === null ? "—" : `${Math.round(averageTps)} tok/s`,
    },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={intl.formatMessage({ id: "chat.sessionStats.trigger" })}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5",
          "text-ui-xs font-mono tabular-nums text-foreground-subtle",
          "transition-colors hover:bg-card-hover hover:text-foreground focus-visible:outline-none",
        )}
        data-testid="chat-session-stats-trigger"
      >
        {capsuleLabel}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-60 rounded-xl p-3"
        data-testid="chat-session-stats-content"
      >
        <p className="mb-2 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.sessionStats.title" })}
        </p>
        <div className="grid gap-1.5">
          {rows.map((row) => (
            <div className="flex min-w-0 items-center gap-2 text-ui-sm" key={row.key}>
              <span className="min-w-0 truncate text-foreground-subtle">
                {intl.formatMessage({ id: row.labelId })}
              </span>
              <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
