/**
 * ChatGPT 账号用量面板（spec settings-usage-reorg D3）。
 *
 * 数据源：
 * - 账户信息（订阅类型/credits/5h·7d 窗口/重置次数）来自 host ChatGPTAccountService
 *   脱敏视图（onDidChangeAccounts 自动刷新）；
 * - 模型用量来自 agent 库 AppUsageSnapshot，按当前账户的
 *   `account:chatgpt:{accountId}` provider 精确过滤（model_usage.provider_id）。
 * 多账户时顶部 SegmentPill 切换；无账户时空态引导到「设置 → 模型设置 → ChatGPT」。
 */
import { useState } from "react";
import type { AppUsageRange } from "@zcode/shared";
import { formatChatGPTCreditsBalance } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAppUsageStats } from "@/hooks/useUsageStats.js";
import { useChatGPTAccounts } from "@/hooks/useChatGPTAccounts.js";
import { useServices } from "@/hooks/useServices.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import { formatCompactNumber } from "@/settings/usage-stats/usageStatsUiParts.js";

const RANGES: Array<{ id: AppUsageRange; label: string }> = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
];

export function ChatGPTUsagePanel() {
  const { intl, locale } = useZCodeIntl();
  const { accounts } = useChatGPTAccounts();
  const platform = useServices();
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [range, setRange] = useState<AppUsageRange>("7d");

  const activeAccount =
    accounts.find((account) => account.accountId === activeAccountId) ?? accounts[0] ?? null;
  const providerId = activeAccount ? `account:chatgpt:${activeAccount.accountId}` : undefined;
  const { snapshot, loading, error } = useAppUsageStats(range, providerId);

  if (accounts.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {intl.formatMessage({ id: "settings.usage.chatgpt.empty" })}
      </div>
    );
  }
  if (!activeAccount) {
    return null;
  }

  const t = (id: string) => intl.formatMessage({ id: `settings.modelProvider.chatgpt.${id}` });
  const windows: Array<{ name: string; usedPercent: number; resetAt?: string }> = [];
  if (activeAccount.usage?.window5h) {
    windows.push({ name: "5h", ...activeAccount.usage.window5h });
  }
  if (activeAccount.usage?.window7d) {
    windows.push({ name: "7d", ...activeAccount.usage.window7d });
  }

  const heatmapWeeks = snapshot?.heatmap.weeks ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {intl.formatMessage({ id: "settings.usage.tab.chatgpt" })}
        </h3>
        <div className="flex gap-1.5">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`rounded-full border px-3 py-1 text-xs ${
                range === option.id
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }`}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {accounts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {accounts.map((account) => {
            const label = account.displayName?.trim() || account.email || account.accountId;
            const selected = account.accountId === activeAccount.accountId;
            return (
              <button
                key={account.accountId}
                type="button"
                data-testid={`chatgpt-usage-account-switch-${account.accountId}`}
                aria-pressed={selected}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  selected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveAccountId(account.accountId)}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}

      <section className="space-y-3" data-testid="chatgpt-usage-account-section">
        <h4 className="text-sm font-medium">
          {activeAccount.displayName?.trim() || activeAccount.email || activeAccount.accountId}
          {activeAccount.profile.planType ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {activeAccount.profile.planType}
            </span>
          ) : null}
        </h4>
        {activeAccount.usage?.credits ? (
          <div className="rounded-lg border border-border p-4 text-sm">
            <div className="text-xs text-muted-foreground">{t("creditsBalance")}</div>
            <div className="text-2xl font-semibold">
              {activeAccount.usage.credits.unlimited
                ? t("creditsUnlimited")
                : (formatChatGPTCreditsBalance(activeAccount.usage.credits.balance) ??
                  t("creditsNone"))}
            </div>
          </div>
        ) : null}
        {windows.map((window) => {
          const remaining = Math.max(0, 100 - window.usedPercent);
          return (
            <div
              key={window.name}
              className="space-y-1 rounded-lg border border-border p-4 text-sm"
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{window.name}</span>
                <span>
                  {intl.formatMessage(
                    { id: "settings.modelProvider.chatgpt.usageRemaining" },
                    { percent: remaining },
                  )}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.min(100, remaining)}%` }}
                />
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between rounded-lg border border-border p-4 text-sm">
          <span className="text-xs text-muted-foreground">{t("resetCreditsCount")}</span>
          <span className="text-lg font-semibold">
            {activeAccount.resetCredits?.availableCount ?? 0}
          </span>
        </div>
      </section>

      <section className="space-y-2" data-testid="chatgpt-usage-stats-section">
        <h4 className="text-sm font-medium">
          {intl.formatMessage({ id: "settings.usage.chatgpt.modelUsage" })}
        </h4>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : loading && !snapshot ? (
          <p className="text-sm text-muted-foreground">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : snapshot && snapshot.summary.totalTokens > 0 ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border p-3 text-sm">
                <div className="text-xs text-muted-foreground">
                  {intl.formatMessage({ id: "settings.usage.chatgpt.totalRequests" })}
                </div>
                <div className="text-xl font-semibold">
                  {formatCompactNumber(
                    locale,
                    (snapshot.models ?? []).reduce((sum, model) => sum + model.requestCount, 0),
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-border p-3 text-sm">
                <div className="text-xs text-muted-foreground">
                  {intl.formatMessage({ id: "settings.usage.chatgpt.totalTokens" })}
                </div>
                <div className="text-xl font-semibold">
                  {formatCompactNumber(locale, snapshot.summary.totalTokens)}
                </div>
              </div>
              <div className="rounded-lg border border-border p-3 text-sm">
                <div className="text-xs text-muted-foreground">
                  {intl.formatMessage({ id: "settings.usage.chatgpt.activeDays" })}
                </div>
                <div className="text-xl font-semibold">{snapshot.summary.activeDays}</div>
              </div>
            </div>

            <UsageHeatmap locale={locale} intl={intl} weeks={heatmapWeeks} countMetric="turns" />

            <div className="space-y-1 text-sm">
              {(snapshot.models ?? []).slice(0, 6).map((model) => (
                <div key={model.modelId ?? "unknown"} className="flex items-center justify-between">
                  <span className="min-w-0 truncate font-mono text-xs">{model.modelId}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatCompactNumber(locale, model.totalTokens)} tok ·{" "}
                    {formatCompactNumber(locale, model.requestCount)} req
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {intl.formatMessage({ id: "settings.usage.chatgpt.noUsage" })}
          </p>
        )}
      </section>
    </div>
  );
}
