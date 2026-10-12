import { BotIcon } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 * ChatGPT 设置页（需求 6）：UA 模拟开关、Codex 版本号手动覆写、service_tier 策略。
 * 版本优先级 = 手动覆写 > Mikiko 远端配置 > 代码内置 fallback（spec §8）。
 */
export function ChatGPTSettingsSection() {
  const { settings, update } = useSettings();
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `settings.chatgpt.${id}` });
  if (!settings) {
    return (
      <div className="text-ui-sm text-foreground-subtle" data-testid="settings-chatgpt-loading">
        {intl.formatMessage({ id: "common.loading" })}
      </div>
    );
  }

  const uaSimulation = settings.chatgptCodexUaSimulation !== false;
  const versionOverride = settings.chatgptCodexVersionOverride ?? "";
  const serviceTier = settings.chatgptServiceTier ?? "auto";

  return (
    <div className="space-y-6" data-testid="settings-chatgpt-section">
      <section className="rounded-xl border border-card-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-ui-base font-medium">
              <BotIcon className="size-4" aria-hidden="true" />
              {t("uaSimulationTitle")}
            </div>
            <p className="mt-1 text-ui-sm text-foreground-subtle">{t("uaSimulationDescription")}</p>
          </div>
          <Switch
            checked={uaSimulation}
            onCheckedChange={(checked: boolean) =>
              void update({ chatgptCodexUaSimulation: checked })
            }
            data-testid="settings-chatgpt-ua-simulation"
          />
        </div>
        {!uaSimulation ? (
          <p className="mt-3 rounded-lg bg-warning/5 px-3 py-2 text-ui-sm text-warning">
            {t("uaSimulationOffWarning")}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-card-border bg-card p-5">
        <Label htmlFor="chatgpt-codex-version" className="text-ui-base font-medium">
          {t("versionOverrideTitle")}
        </Label>
        <p className="mt-1 text-ui-sm text-foreground-subtle">{t("versionOverrideDescription")}</p>
        <Input
          id="chatgpt-codex-version"
          className="mt-3 font-mono"
          placeholder="0.146.0"
          value={versionOverride}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            // 清空输入必须原样传空串：undefined 会被 RPC 吞掉、host 侧 normalize 再把
            // 空串归一回 undefined，覆写才能真正清除（回落远端配置）。
            void update({ chatgptCodexVersionOverride: event.target.value.trim() });
          }}
        />
      </section>

      <section className="rounded-xl border border-card-border bg-card p-5">
        <Label className="text-ui-base font-medium">{t("serviceTierTitle")}</Label>
        <p className="mt-1 text-ui-sm text-foreground-subtle">{t("serviceTierDescription")}</p>
        <Select
          value={serviceTier}
          onValueChange={(value: string) => {
            const next = value === "fast" || value === "flex" ? value : "auto";
            void update({ chatgptServiceTier: next });
          }}
        >
          <SelectTrigger className="mt-3 w-56" data-testid="settings-chatgpt-service-tier">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("serviceTierAuto")}</SelectItem>
            <SelectItem value="fast">{t("serviceTierFast")}</SelectItem>
            <SelectItem value="flex">{t("serviceTierFlex")}</SelectItem>
          </SelectContent>
        </Select>
        <p className={cn("mt-2 text-ui-xs text-foreground-subtlest")}>{t("serviceTierHint")}</p>
      </section>
    </div>
  );
}
