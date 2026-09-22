/**
 * 中转站（Sub2API）使用统计面板。
 *
 * usage 视图：额度总览（账户余额 + 当前 Key 状态）+ Token 活动热力图 + 模型时间线
 * + 模型用量汇总与扇形图；plan 视图：订阅剩余时间与各时间窗口剩余额度/重置时间。
 * 图表复用应用用量的通用组件（UsageHeatmap / CodingPlanUsageLineChart），数据由
 * sub2api 面板 dashboard 接口映射。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Cell, Pie, PieChart, Tooltip as RechartsTooltip } from "recharts";

import type {
  Sub2ApiAccountDetail,
  Sub2ApiSitesState,
  Sub2ApiUsageSnapshot,
} from "@zcode/services";
import { ISub2ApiService } from "@zcode/services";
import type { AppUsageHeatmapWeek } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import { CodingPlanUsageLineChart } from "@/settings/usage-stats/CodingPlanUsageLineChart.js";

const PIE_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#f43f5e",
  "#84cc16",
];

function formatUsd(value: number | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "—";
}

/** points → UsageHeatmap 的周格数据；level 按 30 天窗口内 tokens 分位分级。 */
function buildHeatmapWeeks(
  points: Array<{ date: string; tokens: number; requests: number }>,
): AppUsageHeatmapWeek[] {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const maxTokens = Math.max(1, ...points.map((point) => point.tokens));
  const weeks: AppUsageHeatmapWeek[] = [];
  const today = new Date();
  const start = new Date(today);
  const spanDays = Math.max(7, points.length);
  start.setDate(start.getDate() - (spanDays - 1));
  // 对齐到周日开始。
  start.setDate(start.getDate() - start.getDay());
  let weekIndex = 0;
  for (let cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 7)) {
    const days: AppUsageHeatmapWeek["days"] = [];
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const day = new Date(cursor);
      day.setDate(day.getDate() + dayOffset);
      if (day > today) {
        days.push(null);
        continue;
      }
      const y = day.getFullYear();
      const m = `${day.getMonth() + 1}`.padStart(2, "0");
      const d = `${day.getDate()}`.padStart(2, "0");
      const key = `${y}-${m}-${d}`;
      const point = byDate.get(key);
      if (!point || (point.tokens === 0 && point.requests === 0)) {
        days.push({
          date: key,
          level: 0,
          totalTokens: 0,
          turnCount: 0,
          toolCallCount: 0,
        });
        continue;
      }
      const ratio = point.tokens / maxTokens;
      const level = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
      days.push({
        date: key,
        level,
        totalTokens: point.tokens,
        turnCount: point.requests,
        toolCallCount: 0,
      });
    }
    weeks.push({ weekIndex, days });
    weekIndex += 1;
  }
  return weeks;
}

export function Sub2ApiUsagePanel({ initialView }: { initialView: "usage" | "plan" }) {
  const { intl, locale } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const sub2ApiService = baseServices?.sub2ApiService as ISub2ApiService | undefined;
  const [range, setRange] = useState<"7d" | "30d">("7d");
  const [snapshot, setSnapshot] = useState<Sub2ApiUsageSnapshot | null>(null);
  const [sites, setSites] = useState<Sub2ApiSitesState | null>(null);
  const [accountDetail, setAccountDetail] = useState<Sub2ApiAccountDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authedSite = useMemo(() => sites?.sites.find((site) => site.account) ?? null, [sites]);

  useEffect(() => {
    if (!sub2ApiService) {
      return;
    }
    void sub2ApiService.getSites().then(setSites);
    const disposable = sub2ApiService.onDidChange(setSites);
    return () => disposable.dispose();
  }, [sub2ApiService]);

  const loadUsage = useCallback(async () => {
    if (!sub2ApiService || !authedSite) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [usage, detail] = await Promise.all([
        sub2ApiService.getUsageSnapshot(authedSite.siteId, range),
        sub2ApiService.getAccountDetail(authedSite.siteId).catch(() => null),
      ]);
      setSnapshot(usage);
      setAccountDetail(detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [sub2ApiService, authedSite, range]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  if (!sub2ApiService) {
    return null;
  }

  if (!authedSite) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {intl.formatMessage({ id: "settings.sub2api.usage.notLoggedIn" })}
      </p>
    );
  }

  if (initialView === "plan") {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <h3 className="text-sm font-medium">
          {intl.formatMessage({ id: "settings.sub2api.usage.planTitle" })}
          <span className="ml-2 text-xs text-muted-foreground">
            {authedSite.kind === "mikikocc" ? "MikikoCC" : authedSite.siteName}
          </span>
        </h3>
        {loading && !accountDetail ? (
          <p className="text-sm text-muted-foreground">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : accountDetail ? (
          <>
            <div className="rounded-lg border border-border p-4 text-sm">
              <div className="text-xs text-muted-foreground">
                {intl.formatMessage({ id: "settings.sub2api.account.balance" })}
              </div>
              <div className="text-2xl font-semibold">
                {formatUsd(accountDetail.account.balanceUsd)}
              </div>
            </div>
            {accountDetail.subscriptions.map((sub) => (
              <div key={sub.id} className="space-y-2 rounded-lg border border-border p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{sub.groupLabel}</span>
                  <span className="text-xs text-muted-foreground">
                    {sub.expiresAt
                      ? `${intl.formatMessage({ id: "settings.sub2api.subscriptions.expires" })} ${sub.expiresAt.slice(0, 10)}`
                      : sub.status}
                  </span>
                </div>
                {sub.windows.map((window) => {
                  const remaining = Math.max(0, window.limitUsd - window.usedUsd);
                  const percent =
                    window.limitUsd > 0 ? Math.round((remaining / window.limitUsd) * 100) : 0;
                  return (
                    <div key={window.window} className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{window.window}</span>
                        <span>
                          {intl.formatMessage({ id: "settings.sub2api.usage.remaining" })} $
                          {remaining.toFixed(2)}（{percent}%）
                          {window.resetAt
                            ? ` · ${intl.formatMessage({ id: "settings.sub2api.usage.resetAt" })} ${window.resetAt.slice(0, 16).replace("T", " ")}`
                            : ""}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${Math.min(100, percent)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            {accountDetail.subscriptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {intl.formatMessage({ id: "settings.sub2api.usage.noSubscriptions" })}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{error}</p>
        )}
      </div>
    );
  }

  const heatmapWeeks = snapshot ? buildHeatmapWeeks(snapshot.points) : [];
  const xTime = snapshot?.points.map((point) => point.date) ?? [];
  const topModels = [...(snapshot?.models ?? [])]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5);
  const lineSeries = topModels.map((model) => ({
    name: model.model,
    values:
      snapshot?.points.map(
        (point) => point.tokens * (model.totalTokens / Math.max(1, snapshot.totals.tokens)),
      ) ?? [],
  }));
  const pieData = topModels.map((model) => ({
    name: model.model,
    value: model.totalTokens,
  }));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {intl.formatMessage({ id: "settings.usage.tab.sub2api" })}
          <span className="ml-2 text-xs text-muted-foreground">
            {authedSite.kind === "mikikocc" ? "MikikoCC" : authedSite.siteName}
          </span>
        </h3>
        <div className="flex gap-1.5">
          {(["7d", "30d"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`rounded-full border px-3 py-1 text-xs ${
                range === option
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground"
              }`}
              onClick={() => setRange(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {snapshot && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3 text-sm">
              <div className="text-xs text-muted-foreground">
                {intl.formatMessage({ id: "settings.sub2api.usage.totalRequests" })}
              </div>
              <div className="text-xl font-semibold">{snapshot.totals.requests}</div>
            </div>
            <div className="rounded-lg border border-border p-3 text-sm">
              <div className="text-xs text-muted-foreground">
                {intl.formatMessage({ id: "settings.sub2api.usage.totalTokens" })}
              </div>
              <div className="text-xl font-semibold">
                {(snapshot.totals.tokens / 1_000_000).toFixed(2)}M
              </div>
            </div>
            <div className="rounded-lg border border-border p-3 text-sm">
              <div className="text-xs text-muted-foreground">
                {intl.formatMessage({ id: "settings.sub2api.usage.totalCost" })}
              </div>
              <div className="text-xl font-semibold">{formatUsd(snapshot.totals.costUsd)}</div>
            </div>
          </div>

          <section className="space-y-2">
            <h4 className="text-sm font-medium">
              {intl.formatMessage({ id: "settings.sub2api.usage.heatmap" })}
            </h4>
            <UsageHeatmap locale={locale} intl={intl} weeks={heatmapWeeks} countMetric="turns" />
          </section>

          <section className="space-y-2">
            <h4 className="text-sm font-medium">
              {intl.formatMessage({ id: "settings.sub2api.usage.modelTrend" })}
            </h4>
            <CodingPlanUsageLineChart
              xTime={xTime}
              granularity="day"
              series={lineSeries}
              emptyDescription={intl.formatMessage({ id: "settings.sub2api.usage.empty" })}
              valueKind="token"
            />
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-sm font-medium">
                {intl.formatMessage({ id: "settings.sub2api.usage.modelSummary" })}
              </h4>
              <div className="space-y-1 text-sm">
                {topModels.map((model) => (
                  <div key={model.model} className="flex items-center justify-between">
                    <span className="min-w-0 truncate">{model.model}</span>
                    <span className="text-xs text-muted-foreground">
                      {(model.totalTokens / 1000).toFixed(1)}k · {model.requests} req ·{" "}
                      {formatUsd(model.costUsd)}
                    </span>
                  </div>
                ))}
                {topModels.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {intl.formatMessage({ id: "settings.sub2api.usage.empty" })}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">
                {intl.formatMessage({ id: "settings.sub2api.usage.modelShare" })}
              </h4>
              {pieData.length > 0 ? (
                <div className="flex items-center justify-center">
                  <PieChart width={260} height={220}>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={false}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip
                      formatter={(value, name) => [
                        `${(Number(value) / 1000).toFixed(1)}k`,
                        String(name),
                      ]}
                    />
                  </PieChart>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {intl.formatMessage({ id: "settings.sub2api.usage.empty" })}
                </p>
              )}
            </div>
          </section>
        </>
      )}
      {loading && !snapshot && (
        <p className="text-sm text-muted-foreground">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      )}
    </div>
  );
}
