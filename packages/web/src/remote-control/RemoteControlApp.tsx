import { useCallback, useEffect, useRef, useState } from "react";
import type { IPlatformService } from "@zcode/shared";
import { connectViaProtocol, connectViaWebSocket } from "@zcode/client";
import { negotiateP2p, type P2pNegotiation } from "./p2p.js";
import {
  REMOTE_CONTROL_WS_CLOSE,
  type RemoteControlBindResponse,
} from "@zcode/shared/remote-control";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import {
  ConnectionBadge,
  isZh,
  parseRemoteControlQuery,
  REMOTE_PAGE_VERSION,
  RemoteControlScreens,
  StatusCard,
  type ConnectStep,
  type RemoteControlPhase,
  type RemoteControlQuery,
} from "./RemoteControlStatus.js";

/**
 * 手机远控落地页连接器（spec §8/§21.4）。展示组件在 RemoteControlStatus.tsx。
 *
 * 状态机：landing → connecting(阶段化进度) → connected(Root) → reconnecting → connected；
 * 终态：kicked(4001) / expired(4004) / desktop-disconnected(4006，可凭原票据重连)。
 * 重连语义：WS 断开后凭同一 sessionToken 退避重连（relay grace 5min）；
 * 恢复采用「重连后整体重建」——新 service 连接 + Root 重挂载 + 全量 snapshot 投影。
 */

type WebServiceAccessor = Awaited<ReturnType<typeof connectViaWebSocket>>;

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

/** 连接信息面板的延迟探测周期（spec §21.4.2）。 */
const LATENCY_PROBE_INTERVAL_MS = 10_000;

/** 重试上限（spec §21.9）：P2P 与中继连续失败达限后分别降级中继 / 终止重试。 */
const MAX_P2P_FAILURES = 5;
const MAX_RELAY_FAILURES = 5;

/** 由注入的 relay WS 基址推导 HTTP 基址（wss:→https:，ws:→http:）。 */
function resolveRelayHttpBase(relayWsBase: string): string {
  const url = new URL(relayWsBase);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

function phoneWsUrl(relayWsBase: string, sid: string, token: string): string {
  const ua = encodeURIComponent(`${navigator.userAgent.slice(0, 180)}`);
  return `${relayWsBase}/ws/phone?sid=${encodeURIComponent(sid)}&token=${encodeURIComponent(token)}&ua=${ua}&p2p=1`;
}

export function RemoteControlApp({
  relayWsBase,
  platform,
}: {
  relayWsBase: string;
  platform: IPlatformService;
}) {
  const [query] = useState<RemoteControlQuery | null>(() => parseRemoteControlQuery());
  const queryRef = useRef<RemoteControlQuery | null>(query);
  const sessionToken = useRef<string | null>(null);
  const reconnectAttempt = useRef(0);
  const [phase, setPhase] = useState<RemoteControlPhase>({ kind: "landing" });
  const [progressStep, setProgressStep] = useState<ConnectStep>("verify");
  const [progressFailed, setProgressFailed] = useState(false);
  const [services, setServices] = useState<WebServiceAccessor | null>(null);
  const [generation, setGeneration] = useState(0);
  const connectToken = useRef(0);
  /** onClose 已判定终态（被踢/失效/被电脑断开）：catch 分支不得覆盖、不得再重试 bind（spec §21.6）。 */
  const terminalRef = useRef(false);
  /** P2P 连续失败计数（成功清零；达上限后本页面生命周期不再尝试直连，spec §21.9）。 */
  const p2pFailureCount = useRef(0);
  /** 中继连接失败计数（到达 connected 清零；达上限转 failed 终态，spec §21.9）。 */
  const relayFailureCount = useRef(0);
  const p2pSession = useRef<P2pNegotiation | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const relayWsBaseRef = useRef(relayWsBase);
  // 连接信息（spec §21.4.2）：transport 徽标 + 延迟探测 + 连接起始时刻。
  const [transport, setTransport] = useState<"relay" | "p2p">("relay");
  const [connectedSince, setConnectedSince] = useState(() => Date.now());
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const servicesRef = useRef<WebServiceAccessor | null>(null);
  servicesRef.current = services;

  const probeLatency = useCallback(() => {
    const accessor = servicesRef.current;
    if (!accessor) {
      return;
    }
    const startedAt = performance.now();
    void accessor.systemService
      .info()
      .then(() => {
        setLatencyMs(Math.max(1, Math.round(performance.now() - startedAt)));
      })
      .catch(() => {
        setLatencyMs(null);
      });
  }, []);

  useEffect(() => {
    if (phase.kind !== "connected") {
      return;
    }
    probeLatency();
    const timer = setInterval(probeLatency, LATENCY_PROBE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase.kind, generation, probeLatency]);

  const bind = useCallback(async (): Promise<boolean> => {
    if (!queryRef.current) {
      return false;
    }
    setProgressStep("verify");
    setProgressFailed(false);
    const current = queryRef.current;
    const response = await fetch(`${resolveRelayHttpBase(relayWsBaseRef.current)}/api/rc/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sid: current.sid,
        hash: current.hash,
        t: current.t,
        mid: current.mid,
      }),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as RemoteControlBindResponse;
    // relay 能力声明（spec §22）：页面版本低于最低要求时提示刷新（Pages 常新，刷新即升级）。
    const minPageVersion = (body as { relayCapabilities?: { minPageVersion?: number } })
      .relayCapabilities?.minPageVersion;
    if (typeof minPageVersion === "number" && minPageVersion > REMOTE_PAGE_VERSION) {
      setPhase({ kind: "page-outdated" });
      return false;
    }
    sessionToken.current = body.sessionToken;
    // spec §8.1：bind 响应的 relayWsBase 是运行时兜底（构建期注入值失效时生效）。
    if (body.relayWsBase) {
      relayWsBaseRef.current = body.relayWsBase;
    }
    setProgressStep("link");
    return true;
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    const token = sessionToken.current;
    if (!token || !queryRef.current) {
      return;
    }
    const myToken = ++connectToken.current;
    terminalRef.current = false;
    setProgressFailed(false);
    try {
      const accessor = await connectViaWebSocket(
        phoneWsUrl(relayWsBaseRef.current, queryRef.current.sid, token),
        {
          onOpenSocket: (ws) => {
            wsRef.current = ws;
          },
          onClose: (event) => {
            if (connectToken.current !== myToken) {
              return;
            }
            if (event.code === REMOTE_CONTROL_WS_CLOSE.P2P_PROMOTED) {
              return; // P2P 升级后主动关闭中转，属预期。
            }
            connectToken.current += 1; // 使当前连接失效，重连走新一轮。
            p2pSession.current?.dispose();
            p2pSession.current = null;
            setTransport("relay");
            if (event.code === REMOTE_CONTROL_WS_CLOSE.KICKED) {
              terminalRef.current = true;
              setPhase({ kind: "kicked" });
              return;
            }
            if (event.code === REMOTE_CONTROL_WS_CLOSE.SESSION_EXPIRED) {
              terminalRef.current = true;
              setPhase({ kind: "expired" });
              return;
            }
            if (event.code === REMOTE_CONTROL_WS_CLOSE.DESKTOP_DISCONNECTED) {
              // spec §21.2：桌面主动断开，票据仍有效，不自动重连。
              terminalRef.current = true;
              sessionToken.current = null;
              setPhase({ kind: "desktop-disconnected" });
              return;
            }
            // 4002 桌面离线 / 网络断开：退避重连（relay grace 5min 内同 token 有效）。
            setPhase((prev) =>
              prev.kind === "connected" ? { kind: "reconnecting", since: Date.now() } : prev,
            );
            const delay =
              RECONNECT_DELAYS_MS[
                Math.min(reconnectAttempt.current, RECONNECT_DELAYS_MS.length - 1)
              ];
            reconnectAttempt.current += 1;
            window.setTimeout(() => {
              if (connectToken.current === myToken + 1) {
                void connect();
              }
            }, delay);
          },
        },
      );
      if (connectToken.current !== myToken) {
        return; // 已被更新一轮连接取代。
      }
      reconnectAttempt.current = 0;
      relayFailureCount.current = 0;
      setProgressStep("attach");
      setServices(accessor);
      setGeneration((value) => value + 1);
      setConnectedSince(Date.now());
      setLatencyMs(null);
      setTransport("relay");
      setPhase({ kind: "connected" });
      // v2 P2P 升级：失败静默保持中转；成功后重放「受控重连」语义切到直连。
      // 失败达上限后本页面不再尝试直连（spec §21.9；桌面控制器另有 5 次硬上限双保险）。
      if (!p2pSession.current && p2pFailureCount.current < MAX_P2P_FAILURES) {
        void negotiateP2p({
          relayWsBase: relayWsBaseRef.current,
          sid: queryRef.current?.sid ?? "",
          token,
        }).then((session) => {
          if (connectToken.current !== myToken) {
            return;
          }
          if (!session) {
            p2pFailureCount.current += 1;
            return;
          }
          p2pFailureCount.current = 0;
          p2pSession.current = session;
          const p2pServices = connectViaProtocol(session.protocol);
          setServices(p2pServices);
          setGeneration((value) => value + 1);
          setTransport("p2p");
          connectToken.current += 1; // 中转管道进入被替代状态，其 close 回调不再驱动重连。
          wsRef.current?.close(REMOTE_CONTROL_WS_CLOSE.P2P_PROMOTED, "p2p-promoted");
          // spec §9.4 回退：dc 断开/协商载体失败 → 弃直连，复用 §8.3 重连器回中转。
          session.onDisconnected(() => {
            if (p2pSession.current !== session) {
              return;
            }
            p2pSession.current?.dispose();
            p2pSession.current = null;
            // 桌面主动断开/被顶替已由 0x02 控制帧判定终态，dc 断开不再触发回退重连。
            if (terminalRef.current) {
              return;
            }
            setTransport("relay");
            setPhase({ kind: "reconnecting", since: Date.now() });
            reconnectAttempt.current = 0;
            window.setTimeout(() => {
              void connect();
            }, RECONNECT_DELAYS_MS[0]);
          });
          // 应用层断开通知（spec §21.2）：秒级进入终态屏，无需等 ICE 超时或回退重连。
          session.onRemoteDisconnected((reason) => {
            if (p2pSession.current !== session) {
              return;
            }
            p2pSession.current?.dispose();
            p2pSession.current = null;
            terminalRef.current = true;
            sessionToken.current = null;
            connectToken.current += 1; // 终止在途回退重连。
            setPhase({ kind: reason === "superseded" ? "kicked" : "desktop-disconnected" });
          });
        });
      }
    } catch {
      if (connectToken.current !== myToken) {
        return;
      }
      // 升级被拒时 onClose 先于 promise reject 到达并可能已判定终态（被踢 4001 等）：
      // 终态不覆盖、不再重试 bind，保持已展示的状态页（spec §21.6）。
      if (terminalRef.current) {
        return;
      }
      // 连接尝试失败计数（spec §21.9）：达上限进入 failed 终态，不再自动重试。
      relayFailureCount.current += 1;
      if (relayFailureCount.current >= MAX_RELAY_FAILURES) {
        setPhase({ kind: "failed" });
        return;
      }
      // 首连失败（票据失效/网络不可达）→ 尝试重新 bind 一次再重试。
      const bound = await bind();
      if (!bound) {
        setProgressFailed(true);
        setPhase({
          kind: "expired",
          message: isZh() ? "二维码已过期或无效" : "QR code expired or invalid",
        });
        return;
      }
      const delay =
        RECONNECT_DELAYS_MS[Math.min(reconnectAttempt.current, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt.current += 1;
      window.setTimeout(() => {
        if (connectToken.current === myToken) {
          void connect();
        }
      }, delay);
    }
  }, [bind]);

  useEffect(() => {
    if (phase.kind !== "connecting") {
      return;
    }
    void (async () => {
      const bound = await bind();
      if (!bound) {
        setProgressFailed(true);
        setPhase({
          kind: "expired",
          message: isZh()
            ? "二维码已过期或无效，请在电脑上重新生成"
            : "QR code expired. Regenerate it on your computer.",
        });
        return;
      }
      await connect();
    })();
  }, [phase.kind, bind, connect]);

  if (phase.kind === "connected") {
    if (!services) {
      return <StatusCard tone="neutral" title={isZh() ? "正在初始化…" : "Initializing…"} />;
    }
    return (
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          {/* generation 变化即整体重建：新 service 连接 + 全量 snapshot 投影（spec §10 snapshot 恢复路径） */}
          <div className="relative h-dvh w-screen">
            <Root
              key={`remote-control-${generation}`}
              services={services}
              platform={platform}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
              allowOpenWorkspace={false}
              isRemoteSession
            />
            <ConnectionBadge
              transport={transport}
              connectedSince={connectedSince}
              latencyMs={latencyMs}
              probeLatency={probeLatency}
              relayHost={new URL(relayWsBaseRef.current).host}
            />
          </div>
        </ZCodeIntlProvider>
      </AppErrorBoundary>
    );
  }

  return (
    <RemoteControlScreens
      phase={phase}
      displayName={query?.name ?? ""}
      progressStep={progressStep}
      progressFailed={progressFailed}
      onConnect={() => setPhase({ kind: "connecting" })}
      onReconnect={() => {
        sessionToken.current = null; // 强制重新 bind（票据可多次使用，spec §21.1）。
        relayFailureCount.current = 0; // failed 终态的手动重试清零计数（spec §21.9）。
        setProgressStep("verify");
        setProgressFailed(false);
        setPhase({ kind: "connecting" });
      }}
    />
  );
}
