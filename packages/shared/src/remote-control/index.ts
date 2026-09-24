/**
 * 手机远控（Mobile Remote Control）共享线协议。
 *
 * 契约来源：specs/remote/mobile-remote-control.md。字段名、错误码、常量值以该 spec 为准，
 * 修改任何值必须先改 spec。本模块被 relay-server（@zcode/relay-server）、desktop main、
 * 手机 Web 端共同消费，是唯一的协议定义点。
 */

import { z } from "zod";

// ============================================================================
// 常量（spec §5.1）
// ============================================================================

/** 桌面 ↔ relay 控制帧协议版本（数据帧无版本，格式见 encodeDataFrame）。 */
export const REMOTE_CONTROL_PROTOCOL_VERSION = 1;

/** 二维码短时票据有效期（自动刷新模式，spec §21.1）。 */
export const REMOTE_CONTROL_TICKET_TTL_MS = 10 * 60_000;

/** 手机会话凭证（sessionToken）有效期，活跃滑动续期。 */
export const REMOTE_CONTROL_SESSION_TTL_MS = 2 * 60 * 60_000;

/** 手机断开后保留会话（grace）等待重连的窗口。 */
export const REMOTE_CONTROL_SESSION_IDLE_TTL_MS = 5 * 60_000;

/** 单条 WS 消息上限（对齐 v4 协议 mobileRelayBytes 预算哲学）。 */
export const REMOTE_CONTROL_MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;

/** WebRTC 信令总预算，超时放弃 P2P 保持中转。 */
export const REMOTE_CONTROL_P2P_SIGNAL_BUDGET_MS = 15_000;

// ============================================================================
// 手机侧带外控制语义：WS close code（spec §5.1）
// ============================================================================

/**
 * 手机数据管道只透传 RPC 帧（binary），全部控制语义经 WS close code 传达，
 * 保证现有 wrapBrowserWebSocket → SocketProtocol 链路零 text 混入。
 */
export const REMOTE_CONTROL_WS_CLOSE = {
  /** 被新设备顶替（踢人）。 */
  KICKED: 4001,
  /** 桌面长连断开。 */
  DESKTOP_OFFLINE: 4002,
  /** bind 票据校验失败。 */
  TICKET_INVALID: 4003,
  /** sessionToken 过期/作废。 */
  SESSION_EXPIRED: 4004,
  /** 手机主动升级 P2P 后关闭中转管道。 */
  P2P_PROMOTED: 4005,
  /** 桌面主动断开当前设备（spec §21.2，票据仍有效，手机可重连）。 */
  DESKTOP_DISCONNECTED: 4006,
} as const;

export type RemoteControlWsCloseCode =
  (typeof REMOTE_CONTROL_WS_CLOSE)[keyof typeof REMOTE_CONTROL_WS_CLOSE];

// ============================================================================
// 桌面 ↔ relay 控制帧（spec §6.3）
// ============================================================================

export const remoteControlRegisterFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("register"),
    mid: z.string().min(1),
    token: z.string().min(1),
    name: z.string(),
    appVersion: z.string(),
  })
  .strict();

export const remoteControlIssueSessionFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("issue_session"),
    /** true = 长效票据（不设 TTL，spec §21.1）；缺省为 10min 短时票据。 */
    persistent: z.boolean().optional(),
  })
  .strict();

export const remoteControlDisconnectSessionFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("disconnect_session"),
    sid: z.string().min(1),
  })
  .strict();

export const remoteControlRevokeSessionFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("revoke_session"),
    sid: z.string().min(1),
  })
  .strict();

export const remoteControlStreamAcceptedFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("stream_accepted"),
    streamId: z.number().int().nonnegative(),
  })
  .strict();

export const remoteControlStreamCloseNotifyFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("stream_close_notify"),
    streamId: z.number().int().nonnegative(),
  })
  .strict();

export const remoteControlRegisterOkFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("register_ok"),
  })
  .strict();

export const remoteControlSessionIssuedFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("session_issued"),
    sid: z.string().min(1),
    url: z.string().min(1),
    /** null = 长效票据（spec §21.1）。 */
    expiresAt: z.number().int().positive().nullable(),
  })
  .strict();

export const remoteControlSessionInvalidFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("session_invalid"),
    sid: z.string().min(1),
    reason: z.enum(["consumed", "expired", "unknown", "superseded"]),
  })
  .strict();

export const remoteControlStreamOpenFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("stream_open"),
    streamId: z.number().int().nonnegative(),
    sid: z.string().min(1),
    phone: z.object({ ua: z.string(), p2pCapable: z.boolean() }),
    transport: z.literal("relay"),
  })
  .strict();

export const remoteControlStreamCloseFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("stream_close"),
    streamId: z.number().int().nonnegative(),
    /** 关闭的会话（streamId 每桌面连接独立分配不全局唯一；P2P 顶替判定按 sid，spec §21.6）。 */
    sid: z.string().min(1),
    reason: z.enum(["lost", "kicked", "phone_stop", "p2p_promoted"]),
  })
  .strict();

export const remoteControlErrorFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

/** v2 WebRTC 信令载荷（spec §9.2）。 */
export const remoteControlRtcSignalSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("config"), iceServers: z.object({ urls: z.array(z.string()) }) })
    .strict(),
  z.object({ kind: z.literal("p2p_request") }).strict(),
  z.object({ kind: z.literal("offer"), sdp: z.string() }).strict(),
  z.object({ kind: z.literal("answer"), sdp: z.string() }).strict(),
  z.object({ kind: z.literal("ice"), candidate: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("reject"), reason: z.string() }).strict(),
]);
export type RemoteControlRtcSignal = z.infer<typeof remoteControlRtcSignalSchema>;

export const remoteControlRtcSignalFrameSchema = z
  .object({
    v: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    type: z.literal("rtc_signal"),
    streamId: z.number().int().nonnegative(),
    data: remoteControlRtcSignalSchema,
  })
  .strict();

/** 桌面 ↔ relay 控制帧全集（WebSocket text / JSON）。 */
export const remoteControlDesktopFrameSchema = z.discriminatedUnion("type", [
  remoteControlRegisterFrameSchema,
  remoteControlIssueSessionFrameSchema,
  remoteControlRevokeSessionFrameSchema,
  remoteControlDisconnectSessionFrameSchema,
  remoteControlStreamAcceptedFrameSchema,
  remoteControlStreamCloseNotifyFrameSchema,
  remoteControlRtcSignalFrameSchema,
  remoteControlRegisterOkFrameSchema,
  remoteControlSessionIssuedFrameSchema,
  remoteControlSessionInvalidFrameSchema,
  remoteControlStreamOpenFrameSchema,
  remoteControlStreamCloseFrameSchema,
  remoteControlErrorFrameSchema,
]);
export type RemoteControlDesktopFrame = z.infer<typeof remoteControlDesktopFrameSchema>;

export function parseRemoteControlDesktopFrame(raw: string): RemoteControlDesktopFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = remoteControlDesktopFrameSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// ============================================================================
// 前向兼容宽容解析（spec §22）：新客户端 + 旧对端时，未知字段不应导致整帧判非法。
// 仅 relay 侧使用（relay 是共享依赖，必须最先升级并容忍新桌面/新手机发来的扩展字段）。
// ============================================================================

const CONTROL_FRAME_KNOWN_FIELDS = new Set([
  "v",
  "type",
  "mid",
  "token",
  "name",
  "appVersion",
  "persistent",
  "sid",
  "streamId",
  "data",
  "phone",
  "reason",
]);

const SIGNAL_KNOWN_FIELDS = new Set(["kind", "iceServers", "sdp", "candidate", "url", "reason"]);

const SIGNAL_ICE_SERVERS_KNOWN_FIELDS = new Set(["urls"]);

function stripUnknownKeys(value: unknown, known: Set<string>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (known.has(key)) {
      result[key] = source[key];
    }
  }
  return result;
}

/** 宽容解析桌面控制帧：剥除未知顶层字段后再 strict 校验（spec §22 前向兼容）。 */
export function parseRemoteControlDesktopFrameTolerant(
  raw: string,
): RemoteControlDesktopFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const sanitized = stripUnknownKeys(parsed, CONTROL_FRAME_KNOWN_FIELDS);
  const result = remoteControlDesktopFrameSchema.safeParse(sanitized);
  return result.success ? result.data : null;
}

/** 宽容解析手机信令：剥除未知字段（含 config.iceServers 一层）后校验（spec §22）。 */
export function parseRemoteControlRtcSignalTolerant(raw: string): RemoteControlRtcSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const sanitized = stripUnknownKeys(parsed, SIGNAL_KNOWN_FIELDS) as Record<string, unknown>;
  if (
    sanitized != null &&
    typeof sanitized === "object" &&
    sanitized["kind"] === "config" &&
    sanitized["iceServers"] != null &&
    typeof sanitized["iceServers"] === "object"
  ) {
    sanitized["iceServers"] = stripUnknownKeys(
      sanitized["iceServers"],
      SIGNAL_ICE_SERVERS_KNOWN_FIELDS,
    );
  }
  const result = remoteControlRtcSignalSchema.safeParse(sanitized);
  return result.success ? result.data : null;
}

// ============================================================================
// HTTP 契约（spec §5.3 / §6.1）
// ============================================================================

export const remoteControlBindRequestSchema = z
  .object({
    sid: z.string().min(1),
    hash: z.string().min(1),
    t: z.number().int().positive(),
    mid: z.string().min(1),
  })
  .strict();
export type RemoteControlBindRequest = z.infer<typeof remoteControlBindRequestSchema>;

export const remoteControlBindResponseSchema = z
  .object({
    sessionToken: z.string().min(1),
    desktopName: z.string(),
    relayWsBase: z.string().min(1),
    /** relay 协议能力声明（spec §22）：旧手机端按 unknown 容忍，新手机端据此提示刷新升级。 */
    relayCapabilities: z
      .object({
        protocolVersion: z.number().int().nonnegative(),
        /** 手机页低于该版本时提示刷新（Pages 常新，刷新即升级）。 */
        minPageVersion: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .strict();
export type RemoteControlBindResponse = z.infer<typeof remoteControlBindResponseSchema>;

export const remoteControlDeviceRegisterResponseSchema = z
  .object({
    deviceToken: z.string().min(1),
  })
  .strict();
export type RemoteControlDeviceRegisterResponse = z.infer<
  typeof remoteControlDeviceRegisterResponseSchema
>;

// ============================================================================
// 数据帧编解码（spec §6.3：u32be streamId 前缀 + 不透明 RPC 载荷）
// ============================================================================

const STREAM_ID_PREFIX_BYTES = 4;

/** 桌面 → relay 方向：加 streamId 前缀。载荷本体不检查、不修改。 */
export function encodeRemoteControlDataFrame(streamId: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(STREAM_ID_PREFIX_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, streamId, false);
  frame.set(payload, STREAM_ID_PREFIX_BYTES);
  return frame;
}

/** relay → 桌面方向：解出 streamId 与载荷；格式非法返回 null（调用方应断开连接）。 */
export function decodeRemoteControlDataFrame(
  frame: Uint8Array,
): { streamId: number; payload: Uint8Array } | null {
  if (frame.byteLength < STREAM_ID_PREFIX_BYTES) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    streamId: view.getUint32(0, false),
    payload: frame.subarray(STREAM_ID_PREFIX_BYTES),
  };
}

// ============================================================================
// 桌面远控 UI 状态（spec §7.1，Main 为唯一所有者，renderer 只读镜像）
// ============================================================================

export interface RemoteControlConnectedDetail {
  streamId: number;
  phoneUa: string;
  transport: "relay" | "p2p";
  since: number;
}

/** 当前活票据快照：waiting/connected 态也持有，弹窗二维码常驻展示（spec §21.8）。 */
export interface RemoteControlTicketInfo {
  sid: string;
  url: string;
  /** null = 长效票据（spec §21.1）。 */
  expiresAt: number | null;
  autoRefresh: boolean;
}

export type DesktopRemoteControlState =
  | {
      phase: "disabled";
      lastError?: string;
      /**
       * 停用归因（spec §21.10）：`config` = 配置文件 enabled=false（用户可改回）；
       * `unconfigured` = relay 端点缺失。两者 UI 不展示「开启」按钮，区别于用户主动关闭。
       */
      disabledReason?: "config" | "unconfigured";
    }
  | {
      phase: "pending";
      sid: string;
      url: string;
      /** null = 长效票据（spec §21.1）。 */
      expiresAt: number | null;
      autoRefresh: boolean;
    }
  | {
      phase: "waiting";
      since: number;
      /** 最近一次在线设备的 UA（设备卡片展示；无则省略）。 */
      deviceUa?: string;
      ticket?: RemoteControlTicketInfo;
    }
  | { phase: "connected"; detail: RemoteControlConnectedDetail; ticket?: RemoteControlTicketInfo };

export function isRemoteControlActiveState(state: DesktopRemoteControlState): boolean {
  return state.phase === "pending" || state.phase === "waiting" || state.phase === "connected";
}

// ============================================================================
// v2 P2P：Main ↔ 隐藏 RTC 窗口的协商命令/事件（spec §9）
// ============================================================================

/** Main → 隐藏 RTC 窗口。 */
export type RemoteControlRtcCommand =
  | { type: "negotiate"; iceServers: { urls: string[] } }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  /** 协商成功：本消息附带转移的 MessagePortMain，窗口内桥接 DataChannel ↔ 端口。 */
  | { type: "bind-port" }
  /** 拆链前经 DataChannel 发送应用层断开通知（0x02 控制帧，spec §21.2）：手机秒级感知。 */
  | { type: "notify"; reason: "desktop-disconnected" | "superseded" }
  | { type: "abort" };

/** 隐藏 RTC 窗口 → Main。 */
export type RemoteControlRtcEvent =
  | { type: "offer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  | { type: "dc-open" }
  | { type: "dc-closed" }
  | { type: "failed"; reason: string };
