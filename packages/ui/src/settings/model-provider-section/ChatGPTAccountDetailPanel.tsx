import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  KeyRoundIcon,
  LogOutIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  formatChatGPTCreditsBalance,
  type ChatGPTAccountView,
  type ChatGPTUsageWindow,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import {
  ChatGPTModelsManageSection,
  type ChatGPTModelsPanelCallbacks,
  type ChatGPTModelsPanelProvider,
} from "./ChatGPTModelsManageSection.js";
import { ProviderLogo } from "./ProviderLogo.js";

/**
 * ChatGPT 账号详情页（需求 3/8）：名称+邮箱、订阅与额度窗口、重置次数、模型列表；
 * 操作：刷新信息 / 刷新令牌 / 重置额度 / 退出登录；auth-error 时提供重新授权。
 * 数据事实在 host（ChatGPTAccountService），本组件只读 + 命令。
 * 模型列表管理（spec §9.2）见 ChatGPTModelsManageSection（复用 ProviderModelsSection）。
 */

export function ChatGPTAccountDetailPanel({
  accountId,
  modelsPanel,
  modelsPanelCallbacks,
  settingsRevision = 0,
}: {
  accountId: string;
  modelsPanel?: ChatGPTModelsPanelProvider | null;
  modelsPanelCallbacks?: ChatGPTModelsPanelCallbacks;
  settingsRevision?: number;
}) {
  const services = useServices();
  const service = services.chatgptAccountService;
  const { intl } = useZCodeIntl();
  const [account, setAccount] = useState<ChatGPTAccountView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const load = useCallback(async () => {
    if (!service) return;
    try {
      const accounts = await service.getAccounts();
      setAccount(accounts.find((entry) => entry.accountId === accountId) ?? null);
    } catch (error) {
      logger.warn("chatgpt account detail load failed", { error });
    }
  }, [accountId, services]);

  useEffect(() => {
    void load();
    if (!service) return;
    const dispose = service.onDidChangeAccounts((next: ChatGPTAccountView[]) => {
      setAccount(next.find((entry) => entry.accountId === accountId) ?? null);
    });
    return () => dispose.dispose();
  }, [accountId, load, service]);

  const runAction = useCallback(
    async (action: string, invoke: () => Promise<ChatGPTAccountView | void>) => {
      setBusy(action);
      try {
        const next = await invoke();
        if (next) setAccount(next);
        else await load();
        toast(intl.formatMessage({ id: "settings.modelProvider.chatgpt.actionDone" }));
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ id: "settings.modelProvider.chatgpt.actionFailed" }),
          { variant: "warning" },
        );
      } finally {
        setBusy(null);
      }
    },
    [intl, load, services],
  );

  if (!account) {
    return (
      <div className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.chatgpt.accountMissing" })}
      </div>
    );
  }

  const t = (id: string) => intl.formatMessage({ id: `settings.modelProvider.chatgpt.${id}` });
  const authError = account.status.state === "auth-error";
  const windows = usageWindows(account);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo logo={{ type: "builtin", key: "chatgpt" }} className="size-8" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-ui-base font-medium">
                {account.displayName?.trim() || account.email || account.accountId}
              </span>
              {account.profile.planType ? (
                <Badge variant="secondary">{account.profile.planType}</Badge>
              ) : null}
              {authError ? (
                <Badge variant="destructive">
                  <AlertTriangleIcon className="size-3" aria-hidden="true" />
                  {t("statusAuthError")}
                </Badge>
              ) : null}
            </div>
            <div className="truncate text-ui-sm text-foreground-subtle">{account.email}</div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={busy != null}
          onClick={() =>
            void runAction(
              "refreshInfo",
              () =>
                service?.refreshAccountInfo(accountId) ?? Promise.reject(new Error("unavailable")),
            )
          }
          title={t("refreshInfo")}
          data-testid="chatgpt-refresh-info"
        >
          <RefreshCwIcon className={busy === "refreshInfo" ? "size-4 animate-spin" : "size-4"} />
        </Button>
      </div>

      {authError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-ui-sm">
          <div className="font-medium text-destructive">{t("statusAuthError")}</div>
          <div className="mt-1 break-all text-foreground-subtle">
            {account.status.reason ?? "unknown"}
          </div>
          <Button
            className="mt-3"
            size="sm"
            onClick={() =>
              void runAction(
                "reauthorize",
                () => service?.refreshToken(accountId) ?? Promise.reject(new Error("unavailable")),
              )
            }
            disabled={busy != null}
          >
            {t("reauthorize")}
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <InfoCard title={t("subscriptionTitle")}>
          <InfoRow label={t("planType")} value={account.profile.planType ?? "-"} />
          {account.profile.planExpiresAt ? (
            <InfoRow
              label={t("planExpiresAt")}
              value={formatTime(account.profile.planExpiresAt, intl)}
            />
          ) : null}
          {account.usage?.credits ? (
            <InfoRow
              label={t("creditsBalance")}
              value={
                account.usage.credits.unlimited
                  ? t("creditsUnlimited")
                  : (formatChatGPTCreditsBalance(account.usage.credits.balance) ?? t("creditsNone"))
              }
            />
          ) : null}
        </InfoCard>
        <InfoCard title={t("resetCreditsTitle")}>
          <InfoRow
            label={t("resetCreditsCount")}
            value={String(account.resetCredits?.availableCount ?? 0)}
          />
          <ul className="mt-1 space-y-0.5 text-ui-sm text-foreground-subtle">
            {(account.resetCredits?.credits ?? []).slice(0, 5).map((credit, index) => (
              <li key={credit.id ?? index} className="truncate">
                #{index + 1}
                {credit.expiresAt
                  ? ` · ${t("resetCreditExpires")} ${formatTime(credit.expiresAt, intl)}`
                  : ""}
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={busy != null || (account.resetCredits?.availableCount ?? 0) <= 0}
            onClick={() =>
              void runAction(
                "resetQuota",
                () => service?.resetQuota(accountId) ?? Promise.reject(new Error("unavailable")),
              )
            }
            data-testid="chatgpt-reset-quota"
          >
            <RotateCcwIcon className="size-3.5" aria-hidden="true" />
            {t("resetQuota")}
          </Button>
        </InfoCard>
      </div>

      <InfoCard title={t("usageTitle")}>
        {windows.length === 0 ? (
          <div className="text-ui-sm text-foreground-subtle">{t("usageEmpty")}</div>
        ) : (
          <div className="space-y-2">
            {windows.map((entry) => (
              <UsageMeter key={entry.name} intl={intl} {...entry} />
            ))}
          </div>
        )}
      </InfoCard>

      {modelsPanel ? (
        <ChatGPTModelsManageSection
          modelsPanel={modelsPanel}
          callbacks={modelsPanelCallbacks}
          settingsRevision={settingsRevision}
        />
      ) : (
        <InfoCard title={t("modelsTitle")}>
          {account.models && account.models.slugs.length > 0 ? (
            // Registry 视图尚未就绪时保留只读 Badge 降级，避免模型区空白。
            <div className="flex flex-wrap gap-1.5">
              {account.models.slugs.map((slug) => (
                <Badge key={slug} variant="outline" className="font-mono text-ui-xs">
                  {slug}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-ui-sm text-foreground-subtle">{t("modelsEmpty")}</div>
          )}
        </InfoCard>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t border-card-border pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy != null}
          onClick={() =>
            void runAction(
              "refreshToken",
              () => service?.refreshToken(accountId) ?? Promise.reject(new Error("unavailable")),
            )
          }
        >
          <KeyRoundIcon className="size-3.5" aria-hidden="true" />
          {t("refreshToken")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy != null}
          onClick={() => setConfirmLogout(true)}
        >
          <LogOutIcon className="size-3.5" aria-hidden="true" />
          {t("logout")}
        </Button>
      </div>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("logoutConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("logoutConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmLogout(false)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              variant="destructive"
              disabled={busy != null}
              onClick={() => {
                setConfirmLogout(false);
                void runAction(
                  "logout",
                  () =>
                    service?.logoutAccount(accountId) ?? Promise.reject(new Error("unavailable")),
                );
              }}
            >
              {t("logout")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="mb-2 text-ui-sm font-medium">{title}</div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-ui-sm">
      <span className="text-foreground-subtle">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

function UsageMeter({
  name,
  usedPercent,
  resetAt,
  intl,
}: {
  name: string;
  usedPercent: number;
  resetAt?: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}) {
  // 修复依据（2026-10-14 自测反馈）：进度条填充的是已用比例，但文案此前写「剩余 xx%」，
  // 两个口径混用容易转换不过来。统一为「已用 xx%」——与进度条填充方向一致。
  return (
    <div>
      <div className="flex items-center justify-between text-ui-sm">
        <span>{name}</span>
        <span className="text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.usageRemaining" },
            { percent: Math.min(100, Math.max(0, usedPercent)) },
          )}
          {resetAt
            ? ` · ${intl.formatMessage({ id: "settings.modelProvider.chatgpt.usageResetsAt" }, { time: formatTime(resetAt, intl) })}`
            : ""}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={
            usedPercent >= 90
              ? "h-full rounded-full bg-destructive"
              : usedPercent >= 75
                ? "h-full rounded-full bg-primary/70"
                : "h-full rounded-full bg-primary"
          }
          style={{ width: `${Math.min(100, usedPercent)}%` }}
        />
      </div>
    </div>
  );
}

function usageWindows(account: ChatGPTAccountView): Array<{ name: string } & ChatGPTUsageWindow> {
  const usage = account.usage;
  if (!usage) return [];
  const windows: Array<{ name: string } & ChatGPTUsageWindow> = [];
  if (usage.window5h) windows.push({ name: "5h", ...usage.window5h });
  if (usage.window7d) windows.push({ name: "7d", ...usage.window7d });
  for (const additional of usage.additionalWindows) {
    windows.push(additional);
  }
  return windows;
}

function formatTime(value: string, _intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
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
