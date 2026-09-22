/* eslint-disable max-lines -- Sub2API 设置分区需要集中承载多站点管理、余额/订阅卡片与密钥→模型两层管理，拆分会切断共享的表单与轮询上下文 */
/**
 * Mikiko 网关（Sub2API 中转站）设置分区。
 *
 * 多站点管理：MikikoCC（内置地址）+ 用户添加的 Sub2api 站点（BaseURL 验证后保存）。
 * 登录态展示账户余额与订阅（独立卡片、对客窗口文案、显著百分比与异色进度条）；
 * API 密钥行用 Switch 表达启停（启停即对应密钥供应商在会话模型列表的可见性），
 * 每个密钥可展开完整的模型管理卡（复用个人供应商的模型列表组件：上下文/能力
 * 配置、测试、编辑、开关、添加模型）。登录后自动把全部密钥同步为独立供应商，
 * 模型清单落本地离线使用，会话模型选择器按「密钥 → 模型」两层展示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Sub2ApiAccountDetail,
  Sub2ApiGroupInfo,
  Sub2ApiKeyRecord,
  Sub2ApiSiteState,
  Sub2ApiSitesState,
} from "@zcode/services";
import { ISub2ApiService } from "@zcode/services";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import { Sub2ApiLoginPanel } from "@/settings/Sub2ApiLoginPanel.js";

const inputClassName =
  "flex h-8 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none";

/** 订阅窗口配色：每日蓝 / 每周紫 / 每月绿。 */
const WINDOW_BAR_COLORS = ["bg-blue-500", "bg-violet-500", "bg-emerald-500"] as const;

function formatUsd(value: number | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "—";
}

export function Sub2ApiSection({
  initialSiteId,
  embedded = false,
  addSiteRequested = false,
  onAddSiteRequestConsumed,
}: {
  initialSiteId?: string;
  embedded?: boolean;
  addSiteRequested?: boolean;
  onAddSiteRequestConsumed?: () => void;
} = {}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const { sub2ApiService } = useServices() as { sub2ApiService: ISub2ApiService };
  const [sitesState, setSitesState] = useState<Sub2ApiSitesState | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [accountDetail, setAccountDetail] = useState<Sub2ApiAccountDetail | null>(null);
  const [keys, setKeys] = useState<Sub2ApiKeyRecord[]>([]);
  const [addSiteUrl, setAddSiteUrl] = useState("");
  const [addSiteBusy, setAddSiteBusy] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createGroupId, setCreateGroupId] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [managedKeyId, setManagedKeyId] = useState<string | null>(null);
  const [renamingKeyId, setRenamingKeyId] = useState<string | null>(null);
  const [subIndex, setSubIndex] = useState(0);
  const [subAnimating, setSubAnimating] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const addSiteInputRef = useRef<HTMLInputElement | null>(null);

  const modelProvidersApi = useModelProviders({
    workspacePath: "",
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const providerSettingsView = modelProvidersApi.providerSettingsView;

  useEffect(() => {
    void sub2ApiService.getSites().then((state) => {
      setSitesState(state);
      setSelectedSiteId((current) => current ?? initialSiteId ?? state.sites[0]?.siteId ?? null);
    });
    const disposable = sub2ApiService.onDidChange(setSitesState);
    return () => disposable.dispose();
  }, [sub2ApiService, initialSiteId]);

  useEffect(() => {
    if (addSiteRequested) {
      addSiteInputRef.current?.focus();
      onAddSiteRequestConsumed?.();
    }
  }, [addSiteRequested, onAddSiteRequestConsumed]);

  const selectedSite = useMemo(
    () => sitesState?.sites.find((site) => site.siteId === selectedSiteId) ?? null,
    [sitesState, selectedSiteId],
  );

  const refreshSiteData = useCallback(
    async (site: Sub2ApiSiteState) => {
      if (!site.account) {
        setAccountDetail(null);
        setKeys([]);
        return;
      }
      try {
        const detail = await sub2ApiService.getAccountDetail(site.siteId);
        setAccountDetail(detail);
      } catch (error) {
        // 站点删除竞态期间 getAccountDetail/listKeys 会报"站点不存在"——静默返回，
        // 不向用户弹出删除操作之外的级联错误提示。
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("站点不存在")) {
          return;
        }
        toast(message);
        return;
      }
      try {
        const list = await sub2ApiService.listKeys(site.siteId);
        setKeys(list);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("站点不存在")) {
          toast(message);
        }
      }
    },
    [sub2ApiService],
  );

  useEffect(() => {
    if (selectedSite) {
      void refreshSiteData(selectedSite);
    }
  }, [selectedSite, refreshSiteData]);

  const handleSyncProviders = useCallback(async () => {
    if (!selectedSite) {
      return;
    }
    try {
      await sub2ApiService.syncProviders(selectedSite.siteId);
      await refreshSiteData(selectedSite);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 站点删除竞态期间对已删站点 sync 报"站点不存在"——静默跳过。
      if (!message.includes("站点不存在")) {
        toast(message);
      }
    }
  }, [sub2ApiService, selectedSite, refreshSiteData]);

  // 登录态就绪后自动把全部密钥同步为独立供应商（每站点仅一次；站点间来回切换
  // 只刷新展示数据，不重复触发供应商重建，避免任务执行中模型配置抖动）。
  const autoSyncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedSite?.account || autoSyncedRef.current.has(selectedSite.siteId)) {
      return;
    }
    autoSyncedRef.current.add(selectedSite.siteId);
    void handleSyncProviders();
  }, [selectedSite, handleSyncProviders]);

  const handleAddSite = useCallback(async () => {
    setAddSiteBusy(true);
    try {
      if (selectedSite?.pendingBind) {
        // 待绑定占位记录：填入真实地址校验并完成绑定。
        await sub2ApiService.bindSiteAddress(selectedSite.siteId, addSiteUrl);
      } else {
        await sub2ApiService.addSite(addSiteUrl);
      }
      setAddSiteUrl("");
      toast(intl.formatMessage({ id: "settings.sub2api.site.added" }));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setAddSiteBusy(false);
    }
  }, [sub2ApiService, selectedSite, addSiteUrl, intl]);

  const handleRemoveSite = useCallback(async () => {
    if (!selectedSite || selectedSite.kind === "mikikocc") {
      return;
    }
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "settings.sub2api.site.deleteConfirmTitle" },
        { name: selectedSite.siteName ?? selectedSite.panelBaseUrl },
      ),
      description: intl.formatMessage({ id: "settings.sub2api.site.deleteConfirmDesc" }),
      confirmVariant: "destructive",
      confirmLabel: intl.formatMessage({ id: "settings.sub2api.site.deleteConfirmAction" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (!confirmed) {
      return;
    }
    // 先清理本地选中态再调远端删除：onDidChange 触发后 selectedSite 变 null，
    // 避免选中已删站点再触发 getAccountDetail/listKeys 产生"站点不存在"级联报错。
    const deletingSiteId = selectedSite.siteId;
    setSelectedSiteId(null);
    setManagedKeyId(null);
    setAccountDetail(null);
    setKeys([]);
    try {
      await sub2ApiService.removeSite(deletingSiteId);
      toast(intl.formatMessage({ id: "settings.sub2api.site.removed" }));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }, [sub2ApiService, selectedSite, confirmDialog, intl]);

  const handleLogout = useCallback(async () => {
    if (!selectedSite) {
      return;
    }
    await sub2ApiService.logout(selectedSite.siteId);
    setAccountDetail(null);
    setKeys([]);
    setManagedKeyId(null);
  }, [sub2ApiService, selectedSite]);

  const handleRefreshAccount = useCallback(async () => {
    if (!selectedSite) {
      return;
    }
    await sub2ApiService.refreshAccount(selectedSite.siteId);
    await refreshSiteData(selectedSite);
  }, [sub2ApiService, selectedSite, refreshSiteData]);

  const handleCreateKey = useCallback(async () => {
    if (!selectedSite) {
      return;
    }
    setCreateBusy(true);
    try {
      const groupId = createGroupId ? Number(createGroupId) : null;
      const record = await sub2ApiService.createKey(selectedSite.siteId, {
        name: createName.trim() || `Key ${keys.length + 1}`,
        groupId,
      });
      setCreateName("");
      setCreateGroupId("");
      toast(intl.formatMessage({ id: "settings.sub2api.keys.created" }, { name: record.name }));
      await handleSyncProviders();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  }, [
    sub2ApiService,
    selectedSite,
    createName,
    createGroupId,
    keys.length,
    intl,
    handleSyncProviders,
  ]);

  const handleUpdateKey = useCallback(
    async (
      keyId: string,
      patch: { name?: string; groupId?: number | null; status?: "active" | "inactive" },
    ) => {
      if (!selectedSite) {
        return;
      }
      try {
        await sub2ApiService.updateKey(selectedSite.siteId, keyId, patch);
        await handleSyncProviders();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [sub2ApiService, selectedSite, handleSyncProviders],
  );

  const handleDeleteKey = useCallback(
    async (keyId: string) => {
      if (!selectedSite) {
        return;
      }
      try {
        await sub2ApiService.deleteKey(selectedSite.siteId, keyId);
        if (managedKeyId === keyId) {
          setManagedKeyId(null);
        }
        await handleSyncProviders();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [sub2ApiService, selectedSite, managedKeyId, handleSyncProviders],
  );

  const groups: Sub2ApiGroupInfo[] = accountDetail?.groups ?? [];
  const subscriptions = accountDetail?.subscriptions ?? [];
  const currentSub =
    subscriptions.length > 0 ? subscriptions[Math.min(subIndex, subscriptions.length - 1)] : null;

  const switchSubscription = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= subscriptions.length || subAnimating) {
        return;
      }
      setSubAnimating(true);
      setSubIndex(nextIndex);
      // 动画时长与 CSS 过渡一致。
      setTimeout(() => setSubAnimating(false), 250);
    },
    [subscriptions.length, subAnimating],
  );

  const formProviders = useMemo(
    () =>
      providerSettingsView ? projectProviderSettingsViewToFormProviders(providerSettingsView) : [],
    [providerSettingsView],
  );

  const managedKey = useMemo(
    () => keys.find((key) => key.id === managedKeyId) ?? null,
    [keys, managedKeyId],
  );
  const managedKeyFormProvider = useMemo(() => {
    if (!selectedSite || !managedKey) {
      return null;
    }
    const binding = selectedSite.providerBindings.find((entry) => entry.keyId === managedKey.id);
    if (!binding) {
      return null;
    }
    return formProviders.find((provider) => provider.providerId === binding.providerId) ?? null;
  }, [selectedSite, managedKey, formProviders]);

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="settings-sub2api-section">
      <div className={`mx-auto w-full ${embedded ? "max-w-none" : "max-w-3xl"} space-y-6 p-6`}>
        <section className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold">
              {intl.formatMessage({
                id:
                  selectedSite?.kind === "sub2api"
                    ? "settings.sub2api.title.sub2api"
                    : "settings.sub2api.title.mikikocc",
              })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {intl.formatMessage({
                id:
                  selectedSite?.kind === "sub2api"
                    ? "settings.sub2api.description.sub2api"
                    : "settings.sub2api.description.mikikocc",
              })}
            </p>
          </div>
          {selectedSite && selectedSite.kind !== "mikikocc" ? (
            <div className="flex shrink-0 items-center gap-2">
              {selectedSite.account ? (
                <Switch
                  size="sm"
                  checked={selectedSite.enabled}
                  aria-label={intl.formatMessage({ id: "settings.sub2api.site.toggle" })}
                  onCheckedChange={(checked) =>
                    void sub2ApiService
                      .setSiteEnabled(selectedSite.siteId, checked)
                      .catch((error: unknown) =>
                        toast(error instanceof Error ? error.message : String(error)),
                      )
                  }
                />
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "settings.sub2api.site.delete" })}
                onClick={() => void handleRemoveSite()}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ) : null}
        </section>

        {selectedSite && (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  {intl.formatMessage({ id: "settings.sub2api.account.title" })}
                </h3>
                <div className="flex items-center gap-2">
                  {selectedSite.account ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRefreshAccount()}
                      >
                        {intl.formatMessage({ id: "settings.sub2api.account.refresh" })}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
                        {intl.formatMessage({ id: "settings.sub2api.account.logout" })}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {!selectedSite.account ? (
                <div className="space-y-3">
                  {selectedSite.pendingBind ? (
                    <div className="flex gap-2">
                      <input
                        ref={addSiteInputRef}
                        className={inputClassName}
                        placeholder={intl.formatMessage({
                          id: "settings.sub2api.site.urlPlaceholder",
                        })}
                        value={addSiteUrl}
                        onChange={(event) => setAddSiteUrl(event.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={addSiteBusy || addSiteUrl.trim().length < 8}
                        onClick={() => void handleAddSite()}
                      >
                        {intl.formatMessage({ id: "settings.sub2api.site.add" })}
                      </Button>
                    </div>
                  ) : selectedSite.kind !== "mikikocc" && selectedSite.panelBaseUrl ? (
                    <a
                      href={selectedSite.panelBaseUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-500 underline decoration-blue-500/50 hover:text-blue-600"
                    >
                      {selectedSite.panelBaseUrl}
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  ) : null}
                  {selectedSite.pendingBind ? null : (
                    <Sub2ApiLoginPanel
                      sub2ApiService={sub2ApiService}
                      siteId={selectedSite.siteId}
                      panelBaseUrl={selectedSite.panelBaseUrl}
                      onLoggedIn={() => void refreshSiteData(selectedSite)}
                    />
                  )}
                </div>
              ) : accountDetail ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-4 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {intl.formatMessage({ id: "settings.sub2api.account.email" })}
                      </div>
                      <div className="font-medium">{accountDetail.account.email}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {intl.formatMessage({ id: "settings.sub2api.account.balance" })}
                      </div>
                      <div className="font-medium">
                        {formatUsd(accountDetail.account.balanceUsd)}
                      </div>
                    </div>
                    {selectedSite.kind !== "mikikocc" && selectedSite.panelBaseUrl ? (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          {intl.formatMessage({ id: "settings.sub2api.site.address" })}
                        </div>
                        <a
                          href={selectedSite.panelBaseUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-normal text-blue-500 underline decoration-blue-500/50 hover:text-blue-600"
                        >
                          {selectedSite.panelBaseUrl}
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {intl.formatMessage({ id: "settings.sub2api.account.loading" })}
                </p>
              )}
            </section>

            {selectedSite.account && currentSub ? (
              <section className="relative space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">
                    {intl.formatMessage({ id: "settings.sub2api.subscriptions.title" })}
                  </h3>
                  {subscriptions.length > 1 ? (
                    <div className="relative">
                      <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-hover"
                        onClick={() => {
                          const el = document.querySelector("[data-sub-selector]");
                          if (el) el.classList.toggle("hidden");
                        }}
                      >
                        {currentSub.groupLabel}
                        <ChevronDown className="size-3" />
                      </button>
                      <div
                        data-sub-selector
                        className="absolute right-0 top-full z-10 mt-1 hidden max-h-48 w-48 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
                      >
                        {subscriptions.map((sub, idx) => (
                          <button
                            key={sub.id}
                            type="button"
                            className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${
                              idx === subIndex ? "bg-primary/10 text-primary" : "hover:bg-hover"
                            }`}
                            onClick={() => {
                              switchSubscription(idx);
                              document
                                .querySelector("[data-sub-selector]")
                                ?.classList.add("hidden");
                            }}
                          >
                            <span className="min-w-0 truncate">{sub.groupLabel}</span>
                            {idx === subIndex ? (
                              <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {subscriptions.length > 1 ? (
                    <button
                      type="button"
                      aria-label="上一个订阅"
                      disabled={subIndex === 0 || subAnimating}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover disabled:opacity-30"
                      onClick={() => switchSubscription(subIndex - 1)}
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                  ) : null}
                  <div
                    key={currentSub.id}
                    className={`min-w-0 flex-1 rounded-xl bg-surface p-4 transition-all duration-250 ${
                      subAnimating ? "translate-x-2 opacity-0" : "translate-x-0 opacity-100"
                    }`}
                  >
                    <div>
                      <div className="text-sm font-semibold">{currentSub.groupLabel}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {currentSub.expiresAt
                          ? `${intl.formatMessage({ id: "settings.sub2api.subscriptions.expires" })} ${currentSub.expiresAt.slice(0, 10)}`
                          : currentSub.status}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {currentSub.windows.map((window, wIdx) => {
                        const remaining = Math.max(0, window.limitUsd - window.usedUsd);
                        const percent =
                          window.limitUsd > 0 ? Math.round((remaining / window.limitUsd) * 100) : 0;
                        const cardBg = ["bg-blue-500/10", "bg-violet-500/10", "bg-emerald-500/10"][
                          wIdx % 3
                        ];
                        const barColor = ["bg-blue-500", "bg-violet-500", "bg-emerald-500"][
                          wIdx % 3
                        ];
                        return (
                          <div key={window.window} className={`rounded-lg ${cardBg} p-3`}>
                            <div className="text-xs text-muted-foreground">
                              {intl.formatMessage({
                                id: `settings.sub2api.window.${window.window}`,
                              })}
                            </div>
                            <div className="mt-1 text-lg font-semibold tabular-nums">
                              {percent}%
                            </div>
                            <div className="text-xs text-muted-foreground tabular-nums">
                              ${remaining.toFixed(2)} / ${window.limitUsd.toFixed(2)}
                            </div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/50">
                              <div
                                className={`h-full ${barColor}`}
                                style={{ width: `${Math.min(100, percent)}%` }}
                              />
                            </div>
                            {window.resetAt && (
                              <div className="mt-1.5 text-ui-xs text-muted-foreground">
                                {intl.formatMessage({ id: "settings.sub2api.usage.resetAt" })}{" "}
                                {window.resetAt.slice(5, 16).replace("T", " ")}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {subscriptions.length > 1 ? (
                    <button
                      type="button"
                      aria-label="下一个订阅"
                      disabled={subIndex === subscriptions.length - 1 || subAnimating}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover disabled:opacity-30"
                      onClick={() => switchSubscription(subIndex + 1)}
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {selectedSite.account && managedKey && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({ id: "common.back" })}
                    onClick={() => setManagedKeyId(null)}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <h3 className="text-sm font-medium">
                    {managedKey.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {managedKey.apiKey.slice(0, 12)}…{managedKey.apiKey.slice(-4)}
                    </span>
                  </h3>
                </div>
                {managedKeyFormProvider ? (
                  <InlineEditableProviderCard
                    provider={managedKeyFormProvider}
                    onSave={async (provider) => {
                      await modelProvidersApi.saveProvider(provider);
                    }}
                    onAddPersonalModel={async (providerId, modelId, config, useRecommended) => {
                      await modelProvidersApi.addPersonalModel(
                        providerId,
                        modelId,
                        config,
                        useRecommended,
                      );
                    }}
                    onSavePersonalModelDraft={modelProvidersApi.savePersonalModelDraft}
                    onSetPersonalModelEnabled={modelProvidersApi.setPersonalModelEnabled}
                    onDeletePersonalModel={modelProvidersApi.deletePersonalModel}
                    onReorderModelIds={(modelIds) =>
                      modelProvidersApi.reorderProviderModels(
                        managedKeyFormProvider.providerId,
                        modelIds,
                      )
                    }
                    onTestModel={modelProvidersApi.testModelConnectivity}
                    nameEditable={false}
                    headerVisible={false}
                    settingsRevision={providerSettingsView?.revision}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {intl.formatMessage({ id: "settings.sub2api.keys.syncFirst" })}
                  </p>
                )}
              </section>
            )}

            {selectedSite.account && !managedKey && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">
                    {intl.formatMessage({ id: "settings.sub2api.keys.title" })}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${inputClassName} max-w-48`}
                    placeholder={intl.formatMessage({
                      id: "settings.sub2api.keys.namePlaceholder",
                    })}
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                  />
                  <select
                    className="h-8 rounded-md border border-border bg-transparent px-2 text-sm"
                    value={createGroupId}
                    onChange={(event) => setCreateGroupId(event.target.value)}
                  >
                    <option value="">
                      {intl.formatMessage({ id: "settings.sub2api.keys.noGroup" })}
                    </option>
                    {groups.map((group) => (
                      <option key={group.id} value={String(group.id)}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" disabled={createBusy} onClick={() => void handleCreateKey()}>
                    {intl.formatMessage({ id: "settings.sub2api.keys.create" })}
                  </Button>
                </div>

                <div className="space-y-2">
                  {keys.map((key) => {
                    const binding = selectedSite.providerBindings.find(
                      (entry) => entry.keyId === key.id,
                    );
                    const formProvider = formProviders.find(
                      (provider) => provider.providerId === binding?.providerId,
                    );
                    return (
                      <div key={key.id} className="rounded-md bg-surface px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <div
                            className="min-w-0 flex-1 cursor-pointer text-left"
                            onClick={() => setManagedKeyId(key.id)}
                          >
                            <div className="flex items-center gap-2">
                              {renamingKeyId === key.id ? (
                                <input
                                  autoFocus
                                  className="h-7 w-40 rounded-md border border-border bg-transparent px-2 text-sm"
                                  value={renameValue}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && renameValue.trim()) {
                                      void handleUpdateKey(key.id, { name: renameValue.trim() });
                                      setRenamingKeyId(null);
                                    }
                                    if (event.key === "Escape") {
                                      setRenamingKeyId(null);
                                    }
                                  }}
                                  onBlur={() => {
                                    if (renameValue.trim() && renameValue.trim() !== key.name) {
                                      void handleUpdateKey(key.id, { name: renameValue.trim() });
                                    }
                                    setRenamingKeyId(null);
                                  }}
                                />
                              ) : (
                                <span className="font-medium">{key.name}</span>
                              )}
                              <button
                                type="button"
                                aria-label={intl.formatMessage({
                                  id: "settings.sub2api.keys.rename",
                                })}
                                onClick={() => {
                                  setRenamingKeyId(key.id);
                                  setRenameValue(key.name);
                                }}
                              >
                                <Pencil className="size-3 text-muted-foreground" />
                              </button>
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {key.apiKey.slice(0, 12)}…{key.apiKey.slice(-4)}
                              {binding && formProvider
                                ? ` · ${formProvider.models.length} models`
                                : ""}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <select
                              className="h-7 rounded-md border border-border bg-transparent px-1 text-xs"
                              value={key.groupId ? String(key.groupId) : ""}
                              aria-label={intl.formatMessage({
                                id: "settings.sub2api.keys.groupSelect",
                              })}
                              onChange={(event) =>
                                void handleUpdateKey(key.id, {
                                  groupId: event.target.value ? Number(event.target.value) : null,
                                })
                              }
                            >
                              <option value="">
                                {intl.formatMessage({ id: "settings.sub2api.keys.noGroup" })}
                              </option>
                              {groups.map((group) => (
                                <option key={group.id} value={String(group.id)}>
                                  {group.name}
                                </option>
                              ))}
                            </select>
                            <Switch
                              size="sm"
                              checked={key.status === "active"}
                              aria-label={intl.formatMessage({
                                id: "settings.sub2api.keys.toggleStatus",
                              })}
                              onCheckedChange={(checked) =>
                                void handleUpdateKey(key.id, {
                                  status: checked ? "active" : "inactive",
                                })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={intl.formatMessage({
                                id: "settings.sub2api.keys.delete",
                              })}
                              onClick={() => void handleDeleteKey(key.id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={intl.formatMessage({
                                id: "settings.sub2api.keys.manageModels",
                              })}
                              onClick={() => setManagedKeyId(key.id)}
                            >
                              <ChevronRight className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {keys.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {intl.formatMessage({ id: "settings.sub2api.keys.empty" })}
                    </p>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
