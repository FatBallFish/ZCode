import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Check,
  Copy,
  Info,
  Laptop,
  Loader2,
  Monitor,
  RefreshCw,
  Smartphone,
  Unlink,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DesktopRemoteControlState } from "@zcode/shared/remote-control";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { detectDevice, parseUaSummary } from "@/remoteControl/deviceUa.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 移动端远程控制弹窗（spec §7.5/§21.8，样式对齐 2026-09-24 设计稿）：
 * 二维码 + 刷新 + 复制链接在所有相位常驻；连接/等待态顶部展示设备卡片
 * （形态图标 + UA 截断 + 断开按钮，仅连接态显示断开）。
 */

/** 自动刷新偏好持久化 key（spec §21.1.5，UI 偏好归 renderer）。 */
const AUTO_REFRESH_STORAGE_KEY = "zcode:remote-control:auto-refresh";

export function readRemoteControlAutoRefreshPref(): boolean {
  try {
    return window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRemoteControlAutoRefreshPref(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage 不可用时静默降级为会话内记忆。
  }
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function QrCanvas({ url, size = 188 }: { url: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { width: size, margin: 1, errorCorrectionLevel: "M" })
      .then((result) => {
        if (!cancelled) {
          setDataUrl(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDataUrl(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);
  if (!dataUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-md bg-background"
        style={{ width: size, height: size }}
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <img src={dataUrl} alt="QR" className="rounded-md" style={{ width: size, height: size }} />
  );
}

/** 票据时效胶囊：短时票据倒计时；长效票据「长期有效」（spec §21.1）。 */
function TicketExpiryCapsule({ expiresAt }: { expiresAt: number | null }) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt == null) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const longTerm = expiresAt == null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-ui-xs text-muted-foreground",
        !longTerm && now > expiresAt && "text-destructive",
      )}
    >
      <span className={cn("size-1.5 rounded-full", longTerm ? "bg-emerald-500" : "bg-primary")} />
      {longTerm
        ? intl.formatMessage({ id: "remoteControl.expiry.longTerm" })
        : intl.formatMessage(
            { id: "remoteControl.expiry.expiresIn" },
            { time: formatCountdown(expiresAt - now) },
          )}
    </span>
  );
}

/**
 * 设备卡片（spec §21.8）：左形态图标、按设备类型展示的标题 + 状态胶囊、类型化提示行，
 * UA 摘要独立一行（自动截断，行尾 info 图标 hover 展示完整 UA），
 * 右侧断开按钮（仅连接态显示；重连中/已断开不显示）。
 */
function DeviceCard({
  status,
  phoneUa,
  since,
  onDisconnect,
}: {
  status: "connected" | "waiting";
  phoneUa: string;
  since?: number;
  onDisconnect: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "waiting" || since == null) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, since]);
  const device = detectDevice(phoneUa);
  const Icon = device.icon;
  // 解析失败统一「移动设备」文案（spec §21.8），成功则「{设备类型}已连接/可以控制当前工作区」。
  const deviceName = device.name ?? intl.formatMessage({ id: "remoteControl.device.unknown" });
  const remaining = since != null ? 5 * 60_000 - (now - since) : null;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card p-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-foreground-subtle" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-ui-sm font-medium">
            {intl.formatMessage(
              {
                id:
                  status === "connected"
                    ? "remoteControl.connected.title"
                    : "remoteControl.waiting.title",
              },
              { device: deviceName },
            )}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-ui-xs",
              status === "connected"
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-amber-500/10 text-amber-600",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                status === "connected" ? "bg-emerald-500" : "bg-amber-500 animate-pulse",
              )}
            />
            {deviceName}
            {status === "waiting" && remaining != null ? ` · ${formatCountdown(remaining)}` : ""}
          </span>
        </div>
        <p className="text-ui-xs text-muted-foreground">
          {status === "connected"
            ? intl.formatMessage({ id: "remoteControl.connected.hint" }, { device: deviceName })
            : intl.formatMessage({ id: "remoteControl.waiting.hint" })}
        </p>
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono text-ui-xs text-muted-foreground/80">
            {parseUaSummary(phoneUa || "")}
          </span>
          <ControlHintTooltip title={phoneUa || "-"} side="top">
            <span
              className="inline-flex size-4 shrink-0 cursor-help items-center justify-center text-muted-foreground/60 hover:text-foreground-subtle"
              data-testid="remote-control-ua-detail"
              role="note"
            >
              <Info className="size-3.5" />
            </span>
          </ControlHintTooltip>
        </div>
      </div>
      {status === "connected" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={intl.formatMessage({ id: "remoteControl.connected.disconnect" })}
          title={intl.formatMessage({ id: "remoteControl.connected.disconnect" })}
          data-testid="remote-control-disconnect"
          onClick={onDisconnect}
        >
          <Unlink className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

/** 复制链接按钮（spec §21.3.2）：成功后短暂切换为「已复制」。 */
function CopyLinkButton({ url }: { url: string }) {
  const { intl } = useZCodeIntl();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);
  const copy = () => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        if (timerRef.current != null) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // 剪贴板权限拒绝时保持原状（用户仍可手动选中复制）。
      });
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} data-testid="remote-control-copy-link">
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {intl.formatMessage({
        id: copied ? "remoteControl.pending.copied" : "remoteControl.pending.copyLink",
      })}
    </Button>
  );
}

export function RemoteControlDialogBody({
  state,
  onStart,
  onStop,
  onDisconnect,
  onRefreshTicket,
  onSetAutoRefresh,
}: {
  state: DesktopRemoteControlState;
  onStart: () => void;
  onStop: () => void;
  onDisconnect: () => void;
  onRefreshTicket: () => void;
  onSetAutoRefresh: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  // 偏好同步：本地持久化的自动刷新开关在 App 重启后回填给 Main（spec §21.1.5）。
  const prefSyncedRef = useRef(false);
  useEffect(() => {
    if (prefSyncedRef.current || state.phase === "disabled") {
      return;
    }
    prefSyncedRef.current = true;
    const pref = readRemoteControlAutoRefreshPref();
    if (state.phase === "pending" && pref !== state.autoRefresh) {
      onSetAutoRefresh(pref);
    }
  }, [state, onSetAutoRefresh]);

  if (state.phase === "disabled") {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
          <Smartphone className="size-7 text-primary" />
        </div>
        <p className="max-w-72 text-center text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "remoteControl.disabled.description" })}
        </p>
        <Button onClick={onStart} data-testid="remote-control-start">
          {intl.formatMessage({ id: "remoteControl.disabled.start" })}
        </Button>
        {state.lastError ? <p className="text-ui-xs text-destructive">{state.lastError}</p> : null}
      </div>
    );
  }

  // 活跃相位共用布局（spec §21.8）：设备卡片 + 二维码 + 时效/开关 + 操作行 常驻。
  const ticket =
    state.phase === "pending"
      ? { url: state.url, expiresAt: state.expiresAt, autoRefresh: state.autoRefresh }
      : (state.ticket ?? null);
  const deviceUa =
    state.phase === "connected"
      ? state.detail.phoneUa
      : state.phase === "waiting"
        ? (state.deviceUa ?? "")
        : "";
  const connected = state.phase === "connected";

  return (
    <div className="flex flex-col gap-3">
      {state.phase !== "pending" && deviceUa ? (
        <DeviceCard
          status={connected ? "connected" : "waiting"}
          phoneUa={deviceUa}
          since={state.phase === "waiting" ? state.since : undefined}
          onDisconnect={onDisconnect}
        />
      ) : null}

      <div className="flex justify-center rounded-xl bg-muted p-4">
        {ticket ? (
          <QrCanvas url={ticket.url} />
        ) : (
          <div className="flex size-[188px] items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {ticket ? (
        <div className="flex items-center justify-center gap-3">
          <TicketExpiryCapsule expiresAt={ticket.expiresAt} />
          <label className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
            <Switch
              checked={ticket.autoRefresh}
              onCheckedChange={(checked) => {
                writeRemoteControlAutoRefreshPref(checked === true);
                onSetAutoRefresh(checked === true);
              }}
              data-testid="remote-control-auto-refresh"
            />
            {intl.formatMessage({ id: "remoteControl.pending.autoRefresh" })}
          </label>
        </div>
      ) : null}

      <p className="text-center text-ui-xs text-muted-foreground">
        {intl.formatMessage({ id: "remoteControl.qr.hint" })}
      </p>
      <div className="flex justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefreshTicket}
          data-testid="remote-control-refresh"
        >
          <RefreshCw className="size-3.5" />
          {intl.formatMessage({ id: "remoteControl.pending.refresh" })}
        </Button>
        {ticket ? <CopyLinkButton url={ticket.url} /> : null}
      </div>

      <Button size="sm" className="self-center" onClick={onStop} data-testid="remote-control-stop">
        {intl.formatMessage({ id: "remoteControl.connected.stop" })}
      </Button>
    </div>
  );
}

export function RemoteControlDialog({
  open,
  onOpenChange,
  state,
  onStart,
  onStop,
  onDisconnect,
  onRefreshTicket,
  onSetAutoRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: DesktopRemoteControlState;
  onStart: () => void;
  onStop: () => void;
  onDisconnect: () => void;
  onRefreshTicket: () => void;
  onSetAutoRefresh: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "remoteControl.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "remoteControl.description" })}
          </DialogDescription>
        </DialogHeader>
        <RemoteControlDialogBody
          state={state}
          onStart={onStart}
          onStop={onStop}
          onDisconnect={onDisconnect}
          onRefreshTicket={onRefreshTicket}
          onSetAutoRefresh={onSetAutoRefresh}
        />
      </DialogContent>
    </Dialog>
  );
}
