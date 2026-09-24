import { Smartphone } from "lucide-react";
import type { DesktopRemoteControlState } from "@zcode/shared/remote-control";
import type { RemoteControlPendingAction } from "@/remoteControl/useRemoteControl.js";
import { BotChannelSection } from "@/remoteControl/BotChannelSection.js";
import { RemoteControlDialogBody } from "@/remoteControl/RemoteControlDialogBody.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 移动端远程控制弹窗（spec §21.9）：左右分栏——左栏手机扫码直连（RemoteControlDialogBody，
 * 二开 relay 实现），右栏 Bot Channel 渠道入口（上游 v3.14.3 合入）。
 * 弹窗本体不含业务状态，动作与 pending 由 useRemoteControl 注入。
 */

export function RemoteControlDialog({
  open,
  onOpenChange,
  state,
  pendingAction,
  workspacePath,
  workspaceIdentity,
  onStart,
  onStop,
  onDisconnect,
  onRefreshTicket,
  onSetAutoRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: DesktopRemoteControlState;
  pendingAction?: RemoteControlPendingAction | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  onStart: () => void;
  onStop: () => void;
  onDisconnect: () => void;
  onRefreshTicket: () => void;
  onSetAutoRefresh: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-6rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-2 p-5 pb-0">
          <DialogTitle>{intl.formatMessage({ id: "remoteControl.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "remoteControl.description" })}
          </DialogDescription>
        </DialogHeader>
        {/* items-stretch：左右分栏边框高度统一（右栏 Bot 列表天然更高，左栏内容垂直居中补齐）。 */}
        <div className="grid items-stretch gap-4 p-5 sm:grid-cols-2">
          <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
            <div className="mb-4 flex items-start gap-2">
              <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0 space-y-1">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "remoteControl.phoneSection.title" })}
                </div>
                <p className="text-ui-base/relaxed text-foreground-subtle">
                  {intl.formatMessage({ id: "remoteControl.phoneSection.description" })}
                </p>
              </div>
            </div>
            <RemoteControlDialogBody
              state={state}
              pendingAction={pendingAction}
              onStart={onStart}
              onStop={onStop}
              onDisconnect={onDisconnect}
              onRefreshTicket={onRefreshTicket}
              onSetAutoRefresh={onSetAutoRefresh}
            />
          </section>
          <BotChannelSection workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
