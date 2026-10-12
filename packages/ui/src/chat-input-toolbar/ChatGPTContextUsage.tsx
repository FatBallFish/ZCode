import { useCallback, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import type { ChatGPTAccountView } from "@zcode/shared";
import { formatChatGPTCreditsBalance } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

/**
 * 会话内 ChatGPT 订阅剩余额度（spec §9.6，需求 7）：当前模型为 chatgpt 账号
 * provider 时在 ChatContextUsage 旁侧展示用量 chip；数据即 host usage 快照，
 * onDidChangeAccounts 事件天然跨窗口广播，重置后各窗口自动刷新。
 * 重置按钮镜像账号详情页 resetQuota；不复制智谱的庆祝动效链路。
 */
export function ChatGPTContextUsage({
  account,
  onResetQuota,
}: {
  account: ChatGPTAccountView;
  onResetQuota?: (accountId: string) => Promise<unknown>;
}) {
  const { intl } = useZCodeIntl();
  const [resetting, setResetting] = useState(false);
  const t = (id: string) => intl.formatMessage({ id: `settings.modelProvider.chatgpt.${id}` });

  const primary = account.usage?.window5h ?? account.usage?.window7d ?? null;
  const resetCount = account.resetCredits?.availableCount ?? 0;

  const handleReset = useCallback(async () => {
    if (!onResetQuota || resetting) return;
    setResetting(true);
    try {
      await onResetQuota(account.accountId);
      toast(t("actionDone"));
    } catch (error) {
      toast(error instanceof Error ? error.message : t("actionFailed"), { variant: "warning" });
      logger.warn("chatgpt context usage reset failed", { error });
    } finally {
      setResetting(false);
    }
  }, [account.accountId, onResetQuota, resetting, t]);

  if (!account.usage || (!primary && !account.usage.credits && resetCount === 0)) {
    return null;
  }
  const remainingPercent = primary ? Math.max(0, 100 - primary.usedPercent) : null;

  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-testid="chatgpt-context-usage-trigger"
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui-sm text-foreground-subtle transition-colors hover:bg-card-hover hover:text-foreground"
        >
          {remainingPercent !== null ? (
            <span data-testid="chatgpt-context-usage-summary">
              {primary === account.usage?.window5h ? "5h" : "7d"} {remainingPercent}%
            </span>
          ) : (
            <span>{t("creditsBalance")}</span>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-ui-sm font-medium">
              {account.displayName?.trim() || account.email || account.accountId}
            </span>
            {account.profile.planType ? (
              <span className="text-ui-xs text-foreground-subtle">{account.profile.planType}</span>
            ) : null}
          </div>
          {primary ? (
            <UsageRow
              label={primary === account.usage?.window5h ? "5h" : "7d"}
              remainingPercent={remainingPercent ?? 0}
              resetAt={primary.resetAt}
              intl={intl}
            />
          ) : null}
          {account.usage?.credits ? (
            <div className="flex items-center justify-between text-ui-sm">
              <span className="text-foreground-subtle">{t("creditsBalance")}</span>
              <span>
                {account.usage.credits.unlimited
                  ? t("creditsUnlimited")
                  : (formatChatGPTCreditsBalance(account.usage.credits.balance) ??
                    t("creditsNone"))}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 text-ui-sm">
            <span className="text-foreground-subtle">{t("resetCreditsCount")}</span>
            <div className="flex items-center gap-2">
              <span>{resetCount}</span>
              {resetCount > 0 && onResetQuota ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-ui-xs"
                  disabled={resetting}
                  onClick={() => void handleReset()}
                  data-testid="chatgpt-context-usage-reset"
                >
                  <RotateCcwIcon className="size-3" aria-hidden="true" />
                  {t("resetQuota")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function UsageRow({
  label,
  remainingPercent,
  resetAt,
  intl,
}: {
  label: string;
  remainingPercent: number;
  resetAt?: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-ui-sm">
        <span className="text-foreground-subtle">{label}</span>
        <span>{remainingPercent}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-primary" style={{ width: `${remainingPercent}%` }} />
      </div>
      {resetAt ? (
        <div className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.usageResetsAt" },
            { time: formatUsageTime(resetAt) },
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 与账号详情页 formatTime 对齐的用量时间展示（本地时区，短格式）。 */
function formatUsageTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
