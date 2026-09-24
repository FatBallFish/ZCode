import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ConnectionFailedScreen, PageOutdatedScreen } from "./TerminalErrorScreens.js";

/**
 * 手机远控落地页的展示组件（spec §8/§21.4）：
 * 状态卡（landing/终态）、阶段化连接进度、连接信息徽标与面板、各状态屏渲染。
 * 连接器逻辑在 RemoteControlApp.tsx，此处仅展示与纯工具。
 */

/** 连接进度步骤（spec §21.4.1）：校验票据 → 建立安全连接 → 挂载桌面会话。 */
export type ConnectStep = "verify" | "link" | "attach";

/** 手机页协议版本（spec §22）：随页面协议能力演进递增；低于 relay 要求时提示刷新。 */
export const REMOTE_PAGE_VERSION = 1;

export type RemoteControlPhase =
  | { kind: "landing" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; since: number }
  | { kind: "kicked" }
  | { kind: "expired"; message?: string }
  | { kind: "desktop-disconnected" }
  | { kind: "failed" }
  | { kind: "page-outdated" };

export interface RemoteControlQuery {
  sid: string;
  hash: string;
  t: number;
  mid: string;
  name: string;
}

export function parseRemoteControlQuery(): RemoteControlQuery | null {
  const params = new URLSearchParams(window.location.search);
  const sid = params.get("sid");
  const hash = params.get("hash");
  const t = Number(params.get("t"));
  const mid = params.get("mid");
  if (!sid || !hash || !Number.isFinite(t) || !mid) {
    return null;
  }
  return { sid, hash, t, mid, name: params.get("name") ?? "" };
}

export function isZh(): boolean {
  return /^zh\b/i.test(navigator.language);
}

const CONNECT_STEPS: ConnectStep[] = ["verify", "link", "attach"];

function stepLabel(step: ConnectStep): string {
  if (isZh()) {
    if (step === "verify") {
      return "校验连接票据";
    }
    return step === "link" ? "建立安全连接" : "挂载桌面会话";
  }
  if (step === "verify") {
    return "Verifying ticket";
  }
  return step === "link" ? "Establishing secure link" : "Mounting desktop session";
}

export function StatusCard({
  tone,
  title,
  description,
  action,
}: {
  tone: "neutral" | "danger";
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span
              className={
                tone === "danger"
                  ? "size-2 rounded-full bg-destructive"
                  : "size-2 rounded-full bg-primary"
              }
            />
            <h1 className="text-ui-sm font-semibold">{title}</h1>
          </div>
          {description ? (
            <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">
              {description}
            </p>
          ) : null}
          {action ? <div className="mt-4">{action}</div> : null}
        </section>
      </div>
    </div>
  );
}

/** 阶段化连接进度（spec §21.4.1）：已完成 ✓、当前步 spinner、失败步标红，附耗时计数。 */
export function ConnectProgressCard({
  title,
  step,
  failed,
  description,
}: {
  title: string;
  step: ConnectStep;
  failed?: boolean;
  description?: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [startedAt] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const activeIndex = CONNECT_STEPS.indexOf(step);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <h1 className="text-ui-sm font-semibold">
            {title}
            <span className="ml-2 font-mono text-ui-xs font-normal text-foreground-subtle">
              {elapsed}s
            </span>
          </h1>
          {description ? (
            <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{description}</p>
          ) : null}
          <ol className="mt-4 flex flex-col gap-2.5" data-testid="remote-control-progress">
            {CONNECT_STEPS.map((current, index) => {
              const isDone = !failed && index < activeIndex;
              const isActive = !failed && index === activeIndex;
              const isFailed = failed && index === activeIndex;
              return (
                <li
                  key={current}
                  className={`flex items-center gap-2.5 text-ui-sm ${
                    isDone
                      ? "text-foreground-subtle"
                      : isActive
                        ? "text-foreground"
                        : isFailed
                          ? "text-destructive"
                          : "text-foreground-subtle/60"
                  }`}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                      isDone
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
                        : isActive
                          ? "border-primary text-primary"
                          : isFailed
                            ? "border-destructive bg-destructive/10 text-destructive"
                            : "border-border text-foreground-subtle/60"
                    }`}
                  >
                    {isDone ? "✓" : isFailed ? "✕" : index + 1}
                  </span>
                  {stepLabel(current)}
                  {isActive ? (
                    <span className="ml-auto inline-block size-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 连接信息徽标与面板（spec §21.4.2）：常驻模式徽标（中继/直连），
 * 展开后显示模式、实时延迟、连接时长与接入点。
 */
export function ConnectionBadge({
  transport,
  connectedSince,
  latencyMs,
  probeLatency,
  relayHost,
}: {
  transport: "relay" | "p2p";
  connectedSince: number;
  latencyMs: number | null;
  probeLatency: () => void;
  relayHost: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const p2p = transport === "p2p";
  return (
    <div className="fixed bottom-3 right-3 z-50 flex flex-col items-end gap-2">
      {open ? (
        <div className="w-60 rounded-xl border border-card-border bg-card p-3 shadow-lg">
          <dl className="flex flex-col gap-1.5 text-ui-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-foreground-subtle">{isZh() ? "连接模式" : "Mode"}</dt>
              <dd className="font-medium">
                {p2p ? (isZh() ? "P2P 直连" : "P2P direct") : isZh() ? "中继" : "Relay"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-foreground-subtle">{isZh() ? "延迟" : "Latency"}</dt>
              <dd className="font-mono">{latencyMs == null ? "—" : `${latencyMs} ms`}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-foreground-subtle">{isZh() ? "连接时长" : "Duration"}</dt>
              <dd className="font-mono">{formatDuration(now - connectedSince)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-foreground-subtle">{isZh() ? "接入点" : "Endpoint"}</dt>
              <dd
                className="max-w-36 truncate font-mono"
                title={p2p ? "WebRTC DataChannel" : relayHost}
              >
                {p2p ? "DataChannel" : relayHost}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="mt-2 w-full rounded-md border border-border px-2 py-1 text-ui-xs text-foreground-subtle"
            onClick={probeLatency}
          >
            {isZh() ? "立即测速" : "Measure now"}
          </button>
        </div>
      ) : null}
      <button
        type="button"
        data-testid="remote-control-transport-badge"
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-ui-xs font-medium shadow-md backdrop-blur ${
          p2p
            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600"
            : "border-primary/40 bg-primary/10 text-primary"
        }`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`size-1.5 rounded-full ${p2p ? "bg-emerald-500" : "bg-primary"}`} />
        {p2p ? (isZh() ? "直连" : "Direct") : isZh() ? "中继" : "Relay"}
      </button>
    </div>
  );
}

/** 非 connected 阶段的状态屏渲染（landing/进度/重连/终态）。 */
export function RemoteControlScreens({
  phase,
  displayName,
  progressStep,
  progressFailed,
  onConnect,
  onReconnect,
}: {
  phase: Exclude<RemoteControlPhase, { kind: "connected" }>;
  displayName: string;
  progressStep: ConnectStep;
  progressFailed: boolean;
  onConnect: () => void;
  onReconnect: () => void;
}) {
  if (phase.kind === "landing") {
    return (
      <StatusCard
        tone="neutral"
        title={
          isZh()
            ? `连接到「${displayName || "未知设备"}」`
            : `Connect to “${displayName || "device"}”`
        }
        description={
          isZh()
            ? "将在公网建立与你电脑 Mikiko 的加密连接，连接后手机上可以查看并继续电脑上的会话。"
            : "This opens an encrypted connection to Mikiko on your computer so you can view and continue sessions from your phone."
        }
        action={
          <button
            type="button"
            data-testid="remote-control-connect"
            className="w-full rounded-lg bg-primary px-3 py-2.5 text-ui-sm font-medium text-primary-foreground"
            onClick={onConnect}
          >
            {isZh() ? "连接" : "Connect"}
          </button>
        }
      />
    );
  }

  if (phase.kind === "connecting" || phase.kind === "reconnecting") {
    return (
      <ConnectProgressCard
        title={
          phase.kind === "connecting"
            ? isZh()
              ? "正在连接…"
              : "Connecting…"
            : isZh()
              ? "连接已断开，正在重连…"
              : "Disconnected, reconnecting…"
        }
        step={phase.kind === "reconnecting" ? "link" : progressStep}
        failed={phase.kind === "connecting" ? progressFailed : false}
        description={
          phase.kind === "reconnecting"
            ? isZh()
              ? "请确认电脑端应用处于运行状态；5 分钟内将自动恢复。"
              : "Make sure the desktop app is running. Auto-recovery within 5 minutes."
            : undefined
        }
      />
    );
  }

  if (phase.kind === "kicked") {
    return (
      <StatusCard
        tone="danger"
        title={isZh() ? "当前会话已在其他地方登录" : "Signed in on another device"}
        description={
          isZh()
            ? "同一台电脑同时只允许一台手机连接，刚才的连接已被新设备顶替。如需在本机使用，请点击下方重新连接。"
            : "Only one phone can connect at a time; the previous connection was replaced. Reconnect below to use this device."
        }
        action={
          <button
            type="button"
            data-testid="remote-control-kicked-reconnect"
            className="w-full rounded-lg bg-primary px-3 py-2.5 text-ui-sm font-medium text-primary-foreground"
            onClick={onReconnect}
          >
            {isZh() ? "重新连接" : "Reconnect"}
          </button>
        }
      />
    );
  }

  if (phase.kind === "desktop-disconnected") {
    return (
      <StatusCard
        tone="neutral"
        title={isZh() ? "已在电脑端断开连接" : "Disconnected from the computer"}
        description={
          isZh()
            ? "电脑端主动断开了这台设备。手机远控功能仍开启，可点击下方按钮凭当前链接重新连接。"
            : "The computer disconnected this device. Mobile remote is still on; reconnect below with the same link."
        }
        action={
          <button
            type="button"
            data-testid="remote-control-reconnect"
            className="w-full rounded-lg bg-primary px-3 py-2.5 text-ui-sm font-medium text-primary-foreground"
            onClick={onReconnect}
          >
            {isZh() ? "重新连接" : "Reconnect"}
          </button>
        }
      />
    );
  }

  if (phase.kind === "page-outdated") {
    return <PageOutdatedScreen />;
  }

  if (phase.kind === "failed") {
    return <ConnectionFailedScreen onRetry={onReconnect} />;
  }

  return (
    <StatusCard
      tone="danger"
      title={isZh() ? "连接已失效" : "Connection expired"}
      description={
        phase.message ??
        (isZh() ? "请在电脑上重新生成二维码。" : "Regenerate the QR code on your computer.")
      }
    />
  );
}
