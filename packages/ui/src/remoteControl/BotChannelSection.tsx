import { memo, useState } from "react";
import type { BotProvider } from "@zcode/shared";
import { Bot as BotIcon } from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<BotProvider, "weixin" | "feishu" | "lark" | "telegram">;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

/**
 * 远控弹窗右栏：Bot Channel 渠道入口（spec §21.9，自上游 WebRemoteControlDialog 提取）。
 * 渠道配置是 workspace 级能力：无 workspacePath（设置页 footer）时整体禁用并提示。
 * BotsDialog 的挂载与打开状态由本组件自治，父级只负责布局与传入 workspace 标识。
 */
export const BotChannelSection = memo(function BotChannelSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);
  const noWorkspace = !workspacePath;

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    if (noWorkspace) {
      return;
    }
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
  };

  const handleOpenBotsDialog = () => {
    if (noWorkspace) {
      return;
    }
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
  };

  return (
    <>
      <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
        <div className="mb-4 flex items-start gap-2">
          <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 space-y-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({
                id: "webRemoteControl.botChannel.title",
              })}
            </div>
            <p className="text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({
                id: "webRemoteControl.botChannel.description",
              })}
            </p>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 gap-3">
          {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
            const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

            return (
              <button
                key={entry.provider}
                type="button"
                disabled={noWorkspace}
                className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-surface"
                onClick={() => handleOpenBotEntry(entry.provider)}
              >
                {/* 渠道入口直接复用 BotsDialog 的渠道 logo，品牌图标本身作为视觉识别。 */}
                <ProviderIcon provider={entry.provider} className="size-12 shrink-0" />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                    <span className="min-w-0 truncate">
                      {intl.formatMessage({
                        id: `webRemoteControl.botChannel.${entry.provider}.title`,
                      })}
                    </span>
                    {regionTagLabelId ? (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                        {intl.formatMessage({ id: regionTagLabelId })}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-ui-base/relaxed text-foreground-subtle">
                    {intl.formatMessage({
                      id: `webRemoteControl.botChannel.${entry.provider}.description`,
                    })}
                  </span>
                  <span className="block text-ui-base font-medium text-primary">
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.configure",
                    })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {noWorkspace ? (
          <p className="mt-3 text-center text-ui-xs text-muted-foreground">
            {intl.formatMessage({ id: "webRemoteControl.botChannel.noWorkspace" })}
          </p>
        ) : (
          <div className="mt-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full justify-center gap-2 enabled:cursor-pointer"
              onClick={handleOpenBotsDialog}
            >
              <BotIcon className="size-3.5" />
              {intl.formatMessage({
                id: "webRemoteControl.botChannel.manageBots",
              })}
            </Button>
          </div>
        )}
      </section>
      {!noWorkspace ? (
        <BotsDialog
          open={botsDialogOpen}
          onOpenChange={setBotsDialogOpen}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          entryProvider={botEntryProvider}
        />
      ) : null}
    </>
  );
});
