import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, Plus, RotateCcw, Trash2 } from "lucide-react";
import { DEFAULT_EXTERNAL_CDP_CONFIGURATION, type AppSettings } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SettingsBreadcrumbReporter,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 与 adapters parseExternalCdpConfiguration 同源的轻量校验；最终校验权威在 main 推送前。 */
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENDPOINT_PATTERN = /^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]+\/?$/;
const BROWSER_ID_PATTERN = /^[a-zA-Z0-9-]*$/;

interface ExternalCdpInstanceDraft {
  id: string;
  endpoint: string;
  name: string;
  expectedBrowserId: string;
}

function parseInstancesConfig(value: string | undefined): ExternalCdpInstanceDraft[] {
  if (value === undefined) return [];
  try {
    const parsed = JSON.parse(value) as { instances?: Record<string, unknown>[] };
    return (parsed.instances ?? []).map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      endpoint: typeof item.endpoint === "string" ? item.endpoint : "",
      name: typeof item.name === "string" ? item.name : "",
      expectedBrowserId: typeof item.expectedBrowserId === "string" ? item.expectedBrowserId : "",
    }));
  } catch {
    return [];
  }
}

function defaultInstanceDraft(): ExternalCdpInstanceDraft {
  return { id: "", endpoint: "http://127.0.0.1:9333", name: "", expectedBrowserId: "" };
}

function validateDrafts(drafts: ExternalCdpInstanceDraft[]): string | null {
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const draft of drafts) {
    if (!INSTANCE_ID_PATTERN.test(draft.id)) return "instanceId";
    if (!ENDPOINT_PATTERN.test(draft.endpoint)) return "endpoint";
    if (ids.has(draft.id) || endpoints.has(draft.endpoint)) return "duplicate";
    ids.add(draft.id);
    endpoints.add(draft.endpoint);
    if (!BROWSER_ID_PATTERN.test(draft.expectedBrowserId)) return "expectedBrowserId";
  }
  return null;
}

function fieldInvalid(draft: ExternalCdpInstanceDraft, field: keyof ExternalCdpInstanceDraft) {
  if (field === "id") return draft.id !== "" && !INSTANCE_ID_PATTERN.test(draft.id);
  if (field === "endpoint") return draft.endpoint !== "" && !ENDPOINT_PATTERN.test(draft.endpoint);
  if (field === "expectedBrowserId")
    return draft.expectedBrowserId !== "" && !BROWSER_ID_PATTERN.test(draft.expectedBrowserId);
  return false;
}

const instanceInputClassName = (invalid: boolean) =>
  cn("text-ui-base", invalid && "border-destructive focus-visible:ring-destructive");

/** 表头字段名 + 信息图标：字段说明与填写建议收纳到 hover tooltip，页面文案只保留一句话用途。 */
function InstanceFieldHeader({ labelId, tooltipId }: { labelId: string; tooltipId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="flex items-center gap-1 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: labelId })}
      <Tooltip>
        <TooltipTrigger asChild>
          <Info
            className="size-3.5 shrink-0 cursor-help opacity-70"
            aria-label={intl.formatMessage({ id: tooltipId })}
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-72">
          {intl.formatMessage({ id: tooltipId })}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}

/** 「浏览器」设置区内的外部浏览器摘要卡：远控开关 + 实例状态 + 进入管理子页入口。 */
export function ExternalBrowserSettingsSection({ onManage }: { onManage: () => void }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();

  const savedConfig = settings?.externalCdpConfig;
  const savedInstances = useMemo(() => parseInstancesConfig(savedConfig), [savedConfig]);
  const savedInstancesDisabled = savedConfig !== undefined && savedInstances.length === 0;
  const remoteControlEnabled = settings?.externalCdpRemoteControlEnabled !== false;

  const handleRemoteControlChange = useCallback(
    async (enabled: boolean) => {
      await update({ externalCdpRemoteControlEnabled: enabled } satisfies Partial<AppSettings>);
    },
    [update],
  );

  return (
    <section className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.externalCdp.section" })}
      </div>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.externalCdp.remoteControl.title" })}
          description={intl.formatMessage({
            id: "settings.externalCdp.remoteControl.description",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.externalCdp.remoteControl.title",
              })}
              checked={remoteControlEnabled}
              onCheckedChange={(checked) => void handleRemoteControlChange(checked)}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.externalCdp.instances.title" })}
          description={intl.formatMessage({
            id: savedInstancesDisabled
              ? "settings.externalCdp.instances.disabledHint"
              : savedConfig === undefined
                ? "settings.externalCdp.instances.defaultHint"
                : "settings.externalCdp.instances.configuredHint",
          })}
          detail={
            <div className="space-y-1">
              {savedInstances.map((instance) => (
                <div key={instance.id} className="text-ui-base text-foreground-subtle">
                  {instance.name || instance.id} · {instance.id} · {instance.endpoint}
                </div>
              ))}
            </div>
          }
          control={
            <Button type="button" variant="outline" onClick={onManage}>
              {intl.formatMessage({ id: "settings.externalCdp.instances.manage" })}
            </Button>
          }
        />
      </SettingsGroupCard>
    </section>
  );
}

/**
 * 外部浏览器实例管理子页：像「新建钩子」一样整页接管「浏览器」设置区，面包屑经 Reporter
 * 上报（设置 / 浏览器 / 外部浏览器实例）；summary / instances 的路由状态由
 * BrowserSettingsSection 持有，本组件只负责编辑与保存。
 */
export function ExternalBrowserInstancesView({ onExit }: { onExit: () => void }) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const { settingService } = useServices();
  const [drafts, setDrafts] = useState<ExternalCdpInstanceDraft[]>([]);
  const [saving, setSaving] = useState(false);

  const savedConfig = settings?.externalCdpConfig;
  const savedInstances = useMemo(() => parseInstancesConfig(savedConfig), [savedConfig]);

  useEffect(() => {
    // 挂载时从已保存配置重建草稿；savedInstances 变化（外部刷新）不覆盖编辑中的草稿，
    // 只有重新进入子页才重建。
    setDrafts(savedInstances);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入子页时初始化草稿。
  }, []);

  const handleSave = useCallback(async () => {
    const invalid = validateDrafts(drafts);
    if (invalid) {
      toast(intl.formatMessage({ id: `settings.externalCdp.invalid.${invalid}` }));
      return;
    }
    setSaving(true);
    try {
      const config = JSON.stringify({
        instances: drafts.map((draft) => ({
          id: draft.id,
          endpoint: draft.endpoint,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          ...(draft.expectedBrowserId.trim()
            ? { expectedBrowserId: draft.expectedBrowserId.trim() }
            : {}),
        })),
      });
      await update({ externalCdpConfig: config } satisfies Partial<AppSettings>);
      // 写后回读校验：host 进程若为旧构建，其内联的 zod schema 会在 update 时剥离新字段，
      // 表现为“提示成功但读不回”。这里把静默失败转成明确的重启指引，不退出编辑页。
      const persisted = await settingService.get();
      if (persisted.externalCdpConfig !== config) {
        toast(intl.formatMessage({ id: "settings.externalCdp.staleHost" }), { durationMs: 8000 });
        return;
      }
      onExit();
      toast(intl.formatMessage({ id: "settings.externalCdp.saved" }));
    } catch (error) {
      toast(intl.formatMessage({ id: "settings.externalCdp.saveFailed" }));
      throw error;
    } finally {
      setSaving(false);
    }
  }, [drafts, intl, onExit, settingService, update]);

  const handleResetDefault = useCallback(async () => {
    setSaving(true);
    try {
      // 不尝试删除字段（patch 无法表达 unset），显式写回默认 JSON：生效语义与内置默认一致。
      await update({
        externalCdpConfig: DEFAULT_EXTERNAL_CDP_CONFIGURATION,
      } satisfies Partial<AppSettings>);
      const persisted = await settingService.get();
      if (persisted.externalCdpConfig !== DEFAULT_EXTERNAL_CDP_CONFIGURATION) {
        toast(intl.formatMessage({ id: "settings.externalCdp.staleHost" }), { durationMs: 8000 });
        return;
      }
      onExit();
      toast(intl.formatMessage({ id: "settings.externalCdp.resetDone" }));
    } catch (error) {
      toast(intl.formatMessage({ id: "settings.externalCdp.saveFailed" }));
      throw error;
    } finally {
      setSaving(false);
    }
  }, [intl, onExit, settingService, update]);

  const updateDraft = useCallback((index: number, patch: Partial<ExternalCdpInstanceDraft>) => {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)),
    );
  }, []);

  const removeDraft = useCallback((index: number) => {
    setDrafts((current) => current.filter((_, position) => position !== index));
  }, []);

  const addDraft = useCallback(() => {
    setDrafts((current) => [...current, defaultInstanceDraft()]);
  }, []);

  const breadcrumbItems: SettingsBreadcrumbItem[] = [
    { label: intl.formatMessage({ id: "settings.externalCdp.instances.pageTitle" }) },
  ];

  return (
    <>
      <SettingsBreadcrumbReporter items={breadcrumbItems} onSectionSelect={onExit} />
      <div className="space-y-4" data-testid="external-cdp-instances">
        <div className="space-y-1">
          <h3 className="text-ui-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.externalCdp.instances.pageTitle" })}
          </h3>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.externalCdp.instances.help" })}
          </p>
        </div>

        <div className="space-y-3 rounded-xl border border-border p-4">
          {drafts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center">
              <div className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.externalCdp.instances.empty" })}
              </div>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={addDraft}>
                <Plus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.externalCdp.instances.add" })}
              </Button>
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_2.5rem] gap-2 sm:grid">
                <InstanceFieldHeader
                  labelId="settings.externalCdp.instances.idLabel"
                  tooltipId="settings.externalCdp.instances.idTooltip"
                />
                <InstanceFieldHeader
                  labelId="settings.externalCdp.instances.endpoint"
                  tooltipId="settings.externalCdp.instances.endpointTooltip"
                />
                <InstanceFieldHeader
                  labelId="settings.externalCdp.instances.name"
                  tooltipId="settings.externalCdp.instances.nameTooltip"
                />
                <InstanceFieldHeader
                  labelId="settings.externalCdp.instances.browserIdentity"
                  tooltipId="settings.externalCdp.instances.browserIdentityTooltip"
                />
                <span />
              </div>
              {drafts.map((draft, index) => (
                <div
                  key={`instance-${index}`}
                  className="grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_2.5rem] sm:items-center"
                >
                  <Input
                    value={draft.id}
                    placeholder="id"
                    aria-label="instance id"
                    className={instanceInputClassName(fieldInvalid(draft, "id"))}
                    onChange={(event) => updateDraft(index, { id: event.target.value })}
                  />
                  <Input
                    value={draft.endpoint}
                    placeholder="http://127.0.0.1:9333"
                    aria-label="instance endpoint"
                    className={instanceInputClassName(fieldInvalid(draft, "endpoint"))}
                    onChange={(event) => updateDraft(index, { endpoint: event.target.value })}
                  />
                  <Input
                    value={draft.name}
                    placeholder={intl.formatMessage({
                      id: "settings.externalCdp.instances.namePlaceholder",
                    })}
                    aria-label="instance name"
                    onChange={(event) => updateDraft(index, { name: event.target.value })}
                  />
                  <Input
                    value={draft.expectedBrowserId}
                    placeholder={intl.formatMessage({
                      id: "settings.externalCdp.instances.browserIdentityPlaceholder",
                    })}
                    aria-label="instance browser identity"
                    className={instanceInputClassName(fieldInvalid(draft, "expectedBrowserId"))}
                    onChange={(event) =>
                      updateDraft(index, { expectedBrowserId: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={intl.formatMessage({ id: "settings.externalCdp.instances.remove" })}
                    onClick={() => removeDraft(index)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <div>
                <Button type="button" variant="link" size="lg" className="px-0" onClick={addDraft}>
                  <Plus className="size-4" aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.externalCdp.instances.add" })}
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="lg" disabled={saving} onClick={() => void handleSave()}>
            {intl.formatMessage({ id: "settings.externalCdp.instances.save" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={saving}
            onClick={() => void handleResetDefault()}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.externalCdp.instances.reset" })}
          </Button>
          <Button type="button" variant="ghost" size="lg" disabled={saving} onClick={onExit}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      </div>
    </>
  );
}
