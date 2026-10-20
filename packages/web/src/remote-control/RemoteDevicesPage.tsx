import { RemoteControlApp } from "./RemoteControlApp.js";
/**
 * remote.mikiko.ai 设备列表页（方案 E.5）：Mikiko ID 登录 → 查看已认领设备 → 发起远控。
 *
 * 路由 /remote/devices（非 ?sid&hash&ws 票据路径，不冲突）。
 * OIDC 回调 /remote/devices/callback：state 校验 + PKCE 交换 → 存 session → 重定向列表。
 */

import { useEffect, useState } from "react";
import {
  buildRemoteAuthorizeUrl,
  clearPendingAuth,
  connectRemoteDevice,
  exchangeRemoteCode,
  generateRemotePkce,
  generateRemoteState,
  listRemoteDevices,
  loadPendingAuth,
  loadRemoteSession,
  storePendingAuth,
  storeRemoteSession,
  clearRemoteSession,
  type RemoteDeviceInfo,
} from "./mikikoRemoteOidc.js";

const RELAY_HTTP_BASE = "https://ws.mikiko.ai";
const RELAY_WS_BASE = "wss://ws.mikiko.ai";

function currentOrigin(): string {
  return window.location.origin;
}

function isCallbackPath(): boolean {
  return window.location.pathname === "/remote/devices/callback";
}

function redirectToDevices(): void {
  window.history.replaceState(null, "", "/remote/devices");
}

export function RemoteDevicesPage(): React.JSX.Element {
  const [phase, setPhase] = useState<"loading" | "login" | "ready" | "connecting" | "error">("loading");
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connectingMid, setConnectingMid] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ sid: string; sessionToken: string } | null>(null);

  useEffect(() => {
    void bootstrap();
    async function bootstrap(): Promise<void> {
      // 1) OIDC 回调处理
      if (isCallbackPath()) {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        const state = params.get("state");
        const pending = loadPendingAuth();
        if (!code || !state || !pending || state !== pending.state) {
          setError("OIDC 回调参数无效，请重试");
          setPhase("error");
          redirectToDevices();
          return;
        }
        clearPendingAuth();
        try {
          const tokens = await exchangeRemoteCode({
            code,
            codeVerifier: pending.codeVerifier,
            redirectUri: `${currentOrigin()}/remote/devices/callback`,
          });
          storeRemoteSession(tokens);
          redirectToDevices();
          // 不 return——继续走下方「拉设备列表」，否则 phase 停在 loading。
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase("error");
          redirectToDevices();
          return;
        }
      }
      // 2) 已有会话 → 拉设备列表
      const session = loadRemoteSession();
      if (!session) {
        setPhase("login");
        return;
      }
      try {
        const list = await listRemoteDevices(session.accessToken, RELAY_HTTP_BASE);
        setDevices(list);
        setPhase("ready");
      } catch (cause) {
        const status = (cause as { status?: number }).status;
        if (status === 401) {
          clearRemoteSession();
          setPhase("login");
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase("error");
        }
      }
    }
  }, []);

  const startLogin = (): void => {
    void (async () => {
      const { codeVerifier, codeChallenge } = await generateRemotePkce();
      const state = generateRemoteState();
      storePendingAuth({ state, codeVerifier });
      const authorizeUrl = buildRemoteAuthorizeUrl({
        redirectUri: `${currentOrigin()}/remote/devices/callback`,
        state,
        codeChallenge,
      });
      window.location.href = authorizeUrl;
    })();
  };

  const connect = async (mid: string): Promise<void> => {
    const session = loadRemoteSession();
    if (!session) {
      setPhase("login");
      return;
    }
    setConnectingMid(mid);
    setPhase("connecting");
    try {
      const result = await connectRemoteDevice(session.accessToken, RELAY_HTTP_BASE, mid);
      // 复用既有 RemoteControlApp 连接器：直接跳到票据入口形态（sid+token），
      // 但用 account connect 签发的凭证替代 HMAC 票据参数。
      const connectUrl = `${currentOrigin()}?sid=${encodeURIComponent(result.sid)}&hash=${encodeURIComponent(result.sessionToken)}&t=${Date.now()}&mid=${encodeURIComponent(mid)}&ws=${encodeURIComponent(RELAY_WS_BASE)}`;
      setConnected({ sid: result.sid, sessionToken: result.sessionToken });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("ready");
      setConnectingMid(null);
    }
  };

  if (phase === "loading") {
    return <div className="flex h-dvh items-center justify-center text-sm text-neutral-500">正在检查登录态…</div>;
  }
  if (phase === "error") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-200">
        <p className="text-sm text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setPhase(loadRemoteSession() ? "ready" : "login");
          }}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-neutral-950"
        >
          重试
        </button>
      </div>
    );
  }
  if (phase === "login") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-neutral-950 text-neutral-200">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-2xl font-black text-neutral-950">
          M
        </div>
        <div className="text-center">
          <h1 className="text-lg font-semibold">Mikiko 远程控制</h1>
          <p className="mt-1 text-sm text-neutral-500">使用 Mikiko ID 登录后管理设备并发起远程控制</p>
        </div>
        <button
          type="button"
          onClick={startLogin}
          className="rounded-xl bg-amber-500 px-8 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-amber-400"
        >
          使用 Mikiko ID 登录
        </button>
      </div>
    );
  }

  if (connected) {
    return (
      <RemoteControlApp
        relayWsBase={RELAY_WS_BASE}
        platform={{} as never}
        preAuthorized={{ sid: connected.sid, sessionToken: connected.sessionToken }}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-neutral-950 text-neutral-200">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <h1 className="text-base font-semibold">我的设备</h1>
          <button
            type="button"
            onClick={() => {
              clearRemoteSession();
              setPhase("login");
            }}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            退出
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-3 p-6">
        {devices.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-800 px-6 py-12 text-center text-sm text-neutral-600">
            暂无已认领设备。在桌面 App 登录 Mikiko ID 并开启手机远控后，设备会自动注册到这里。
          </div>
        )}
        {devices.map((device) => (
          <div
            key={device.mid}
            className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900/40 px-5 py-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block size-2 rounded-full ${device.online ? "bg-emerald-400" : "bg-neutral-600"}`}
                />
                <span className="text-sm font-medium">{device.name}</span>
              </div>
              <p className="mt-0.5 text-xs text-neutral-600">
                {device.online ? "在线" : `离线 · 最近活跃 ${new Date(device.lastSeenAt).toLocaleString("zh-CN")}`}
              </p>
            </div>
            <button
              type="button"
              disabled={!device.online || phase === "connecting"}
              onClick={() => void connect(device.mid)}
              className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-semibold text-neutral-950 disabled:opacity-30"
            >
              {connectingMid === device.mid ? "连接中…" : "远控"}
            </button>
          </div>
        ))}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </main>
    </div>
  );
}

