import { hostname } from "node:os";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { WebSocket } from "ws";
import { PlatformChannels } from "@zcode/shared";
import type { DesktopRemoteControlState } from "@zcode/shared/remote-control";
import { createDeviceCredentialStore, type SafeStorageLike } from "./deviceCredentials.js";
import { createWsTransportFactory } from "./relayConnection.js";
import {
  createRemoteControlService,
  type RemoteControlAttachedPort,
  type RemoteControlService,
} from "./service.js";
import { createRtcController } from "./rtc/rtcController.js";
import { createRtcBrowserWindow, createRtcEventHub } from "./rtc/rtcWindow.js";

/**
 * 生产环境接线：把 remoteControlService 与 Electron（窗口跟踪、safeStorage、ipc 推送）
 * 和 relay 端点连起来。端点解析顺序：环境变量 > `~/.mikiko/remote-control.json` 配置文件；
 * 两者都未配置时返回 null，UI 不展示入口（默认不出网）。
 *
 * 配置文件让打包版 App 免环境变量启用远控（打包进程不易注入 env）：
 *   { "relayWsUrl": "wss://relay.example.com/ws/desktop",
 *     "relayHttpUrl": "https://relay.example.com",
 *     "stunUrls": ["stun:stun.l.google.com:19302"],   // 可选
 *     "deviceName": "我的 MacBook Pro" }               // 可选
 */

interface RemoteControlFileConfig {
  relayWsUrl?: unknown;
  relayHttpUrl?: unknown;
  stunUrls?: unknown;
  deviceName?: unknown;
}

function readRemoteControlFileConfig(
  logger: RemoteControlProductionOptions["logger"],
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
): RemoteControlFileConfig {
  try {
    const raw = JSON.parse(
      readFile(join(homedir(), ".mikiko", "remote-control.json"), "utf8"),
    ) as RemoteControlFileConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {}; // 无配置文件/解析失败都按未配置处理（默认零出网）。
  }
}

export interface RemoteControlProductionOptions {
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  attachPort(webContentsId: number): RemoteControlAttachedPort;
  detachPort(webContentsId: number, attachmentId: string, reason: string): void;
  /** v2 P2P 隐藏窗口使用的 preload 路径（主窗口 preload 同源）。 */
  preloadPath?: string;
  env?: NodeJS.ProcessEnv;
  safeStorageImpl?: SafeStorageLike;
}

export function createRemoteControlProductionService(
  options: RemoteControlProductionOptions,
): RemoteControlService | null {
  const env = options.env ?? process.env;
  // 端点解析顺序：环境变量优先，其次 ~/.mikiko/remote-control.json（打包版 App 免 env 启用）。
  const fileConfig = readRemoteControlFileConfig(options.logger);
  const fileWsUrl =
    typeof fileConfig.relayWsUrl === "string" && fileConfig.relayWsUrl.trim().length > 0
      ? fileConfig.relayWsUrl.trim()
      : undefined;
  const fileHttpUrl =
    typeof fileConfig.relayHttpUrl === "string" && fileConfig.relayHttpUrl.trim().length > 0
      ? fileConfig.relayHttpUrl.trim()
      : undefined;
  const fileStunUrls = Array.isArray(fileConfig.stunUrls)
    ? fileConfig.stunUrls
        .map((url) => (typeof url === "string" ? url.trim() : ""))
        .filter((url) => url.length > 0)
    : undefined;
  const fileDeviceName =
    typeof fileConfig.deviceName === "string" && fileConfig.deviceName.trim().length > 0
      ? fileConfig.deviceName.trim()
      : undefined;
  const relayWsUrl = env.ZCODE_REMOTE_CONTROL_RELAY_WS_URL?.trim() || fileWsUrl;
  const relayHttpUrl = env.ZCODE_REMOTE_CONTROL_RELAY_HTTP_URL?.trim() || fileHttpUrl;
  // 双端点必须成对配置，缺一视为功能关闭（spec §12 场景 11：disabled 状态零出网）。
  if (!relayWsUrl || !relayHttpUrl) {
    return null;
  }

  const deviceStore = createDeviceCredentialStore(
    join(app.getPath("userData"), "remote-control-device.json"),
    options.safeStorageImpl ?? (safeStorage as unknown as SafeStorageLike),
  );
  const deviceName = env.ZCODE_REMOTE_CONTROL_DEVICE_NAME?.trim() || fileDeviceName || hostname();

  let lastFocusedWebContentsId: number | null = null;
  app.on("browser-window-focus", (_event, win) => {
    if (!win.isDestroyed()) {
      lastFocusedWebContentsId = win.webContents.id;
    }
  });

  function activeWebContentsId(): number | null {
    if (
      lastFocusedWebContentsId != null &&
      options.windowHostProcessMap.has(lastFocusedWebContentsId)
    ) {
      return lastFocusedWebContentsId;
    }
    // 无聚焦记录（启动初期）时取任一已有 Host 的窗口。
    for (const webContentsId of options.windowHostProcessMap.keys()) {
      return webContentsId;
    }
    return null;
  }

  async function registerDevice(): Promise<string> {
    const { mid } = await deviceStore.load();
    const response = await fetch(`${relayHttpUrl}/api/rc/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mid, name: deviceName, appVersion: app.getVersion() }),
    });
    if (!response.ok) {
      throw new Error(`device register failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { deviceToken: string };
    await deviceStore.saveToken(body.deviceToken);
    return body.deviceToken;
  }

  const service = createRemoteControlService({
    relayWsUrl,
    transportFactory: createWsTransportFactory(WebSocket),
    device: {
      async ensureCredentials() {
        const stored = await deviceStore.load();
        if (stored.token) {
          return { mid: stored.mid, token: stored.token };
        }
        return { mid: stored.mid, token: await registerDevice() };
      },
      // 连接从未收到 register_ok 即断开时，大概率是 relay 重启导致 token 失效：
      // 清掉本地 token，下次连接前重新注册换发（spec §6.7）。
      clearCredentials() {
        return deviceStore.clearToken();
      },
      get deviceName() {
        return deviceName;
      },
      get appVersion() {
        return app.getVersion();
      },
    },
    attachPort: options.attachPort,
    detachPort: options.detachPort,
    activeWebContentsId,
    broadcastState(state: DesktopRemoteControlState) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(PlatformChannels.RemoteControlStateChanged, { state });
        }
      }
    },
    logger: options.logger,
  });
  if (service == null) {
    return null;
  }

  // relay 版本门控（spec §22）：start 前拉取 healthz，桌面版本低于 relay 最低要求时
  // 禁用远控并提示升级（新桌面 + 旧 relay 的硬故障已由 relay 侧宽容解析兜底，这里管反方向）。
  {
    const originalStart = service.start.bind(service);
    service.start = (): DesktopRemoteControlState => {
      void gateRelayCompatibility(relayWsUrl).then((gate) => {
        if (gate != null) {
          service.markIncompatible(gate);
          return;
        }
        originalStart();
      });
      // 门控异步进行：先返回当前相位，不兼容时随后广播 disabled+lastError。
      return service.getState();
    };
  }

  attachRtc(
    service,
    options,
    activeWebContentsId,
    fileStunUrls ?? [
      // 多服务器 + 国内可达项：单一 Google STUN 在大陆蜂窝网络常不可达，ICE 直接失败（spec §21.7）。
      "stun:stun.miwifi.com:3478",
      "stun:stun.qq.com:3478",
      "stun:stun.l.google.com:19302",
    ],
  );
  return service;
}

/** v2 P2P 接线：隐藏 RTC 窗口 + 信令回路 + transport 徽标联动（service 与 controller 互持回调）。 */
function attachRtc(
  service: RemoteControlService,
  options: RemoteControlProductionOptions,
  activeWebContentsId: () => number | null,
  stunUrls: string[],
): void {
  const env = options.env ?? process.env;

  const hub = createRtcEventHub();
  ipcMain.on(PlatformChannels.RemoteControlRtcEvent, (_event, payload: unknown) => {
    if (payload && typeof payload === "object" && "type" in payload) {
      hub.emit(payload as import("@zcode/shared/remote-control").RemoteControlRtcEvent);
    }
  });
  const controller = createRtcController({
    createWindow: () => createRtcBrowserWindow(options.preloadPath, hub, options.logger),
    sendSignal: (streamId, data) => service.sendRtcSignal(streamId, data),
    attachPort: options.attachPort,
    detachPort: options.detachPort,
    activeWebContentsId,
    onTransportChanged: (transport) => service.updateConnectedTransport(transport),
    onP2pLost: () => service.noteP2pLost(),
    iceServers: { urls: stunUrls },
    logger: options.logger,
  });
  service.setRtcSignalHandler((streamId, data) => {
    controller.handleSignal(
      streamId,
      data as import("@zcode/shared/remote-control").RemoteControlRtcSignal,
    );
  });
  service.setRtcDelegate({
    isP2pActive: () => controller.isActive(),
    // 拆除 P2P（spec §21.2/§21.6）：带 reason 时先发 0x02 应用层通知（手机秒级感知）再硬拆。
    disposeP2p: (reason) => (reason ? controller.disposeWithNotify(reason) : controller.dispose()),
  });
  // 用户 stop/应用退出时连带拆除 P2P（隐藏窗口 + p2p attachment，spec §7.1）。
  service.onStopped(() => controller.dispose());
}

/** semver 风格比较：a < b 返回 -1，相等 0，a > b 返回 1（容错非数字段）。 */
function compareVersionStrings(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * relay 最低版本门控（spec §22）：返回 null 表示放行（含 healthz 不可达——网络问题
 * 交给既有重连语义处理，不因一次探测失败禁用功能）；返回字符串为不兼容提示。
 */
async function gateRelayCompatibility(relayWsUrl: string): Promise<string | null> {
  let healthzUrl: string;
  try {
    const url = new URL(relayWsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/healthz";
    url.search = "";
    healthzUrl = url.toString();
  } catch {
    return null;
  }
  try {
    const response = await fetch(healthzUrl, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      minDesktopAppVersion?: unknown;
      version?: unknown;
    };
    const minimum =
      typeof body.minDesktopAppVersion === "string" ? body.minDesktopAppVersion : null;
    if (!minimum) {
      return null;
    }
    const appVersion = app.getVersion();
    if (compareVersionStrings(appVersion, minimum) < 0) {
      return `当前版本不支持远程控制服务（App ${appVersion} < 服务要求 ${minimum}），请升级应用`;
    }
    return null;
  } catch {
    return null;
  }
}
