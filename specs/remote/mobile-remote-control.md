# 手机远控（Mobile Remote Control）技术方案

> 状态：设计定稿（未实施）。范围：v1 全中转 + v2 P2P 直连，单设备在线（后连踢前连）。
> 关联约束：`AGENTS.md`「进程、协议与远程控制」「Workspace Identity」两节。
> 本文档是实施的唯一契约来源：字段名、错误码、常量值、状态机以本文伪代码为准，实现不得偏离；发现设计缺陷先改本文再改代码。

## 1. 背景与目标

正式版 App 的手机远控 = 「`/remote` base 构建的 Web 页面 + HMAC 签名票据 URL + 官方 relay WS 全中转」（依据：`packages/web/src/env.d.ts` 的 `/remote`、`/remote/v3` 注释与 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 声明、`browserOAuthCredentialRepo.ts:31` 的线上 `/remote` 登录态注释、v4 协议 `mobileRelayBytes` 帧预算命名）。该链路在开源快照中缺失：无二维码生成、无配对票据、无 relay 客户端，仅保留地基。

目标：

1. 手机在公网（蜂窝 / 异地 Wi-Fi）扫码即连桌面 App，复用桌面已有窗口 Host 会话运行时；
2. 中转服务自研、轻量：仅做设备注册、票据签发校验、连接路由、帧转发；内存态、无业务数据落盘；
3. v1 流量全中转；v2 增加 WebRTC DataChannel P2P 直连，中转永久兜底；
4. **单设备在线**：同一桌面任意时刻仅一台手机连接，新设备接入立即踢掉旧设备（含宽限期内的旧设备）；
5. 断网重连、弱网可用，恢复语义完全复用现有 `web-remote-replayable` 水位机制。

## 2. 非目标（本次明确不做）

- 多台手机同时在线 / 多手机会话协商；
- Bot 链接方式；
- 多窗口 / 多 workspace 选择（v1 绑定「当前激活窗口 + 当前 workspace」，切换 workspace 语义见 §10）；
- 端到端帧加密（预留 §11.6，v3 可选）；
- zai OAuth 账号体系接入（票据即凭证）；
- relay 持久化存储（重启即全部重扫，见 §6.7）。

## 3. 角色与状态所有权

| 状态                                           | 唯一所有者                                       | 说明                                                       |
| ---------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 会话/任务权威数据                              | Agent CLI（SQLite 事件溯源）                     | 全链路无人复制业务状态                                     |
| 窗口 Host attachment 注册表                    | `windowHostAttachmentRegistry`（Host 进程）      | 本方案零改动，复用 `AttachServicePort`/`DetachServicePort` |
| 远控会话票据（sid/hash/sessionToken）          | Relay Server（内存）                             | 桌面只展示 URL，不存票据                                   |
| 桌面在线状态 / 手机管道路由表                  | Relay Server（内存，`mid → activeStream`）       | 踢人裁决唯一发生地                                         |
| 桌面侧 attachment 生命周期编排                 | Main 进程 `remoteControlService`（新增）         | 只做转发调度，不碰业务状态                                 |
| 远控 UI 状态（idle/pending/connected/waiting） | Main `remoteControlService`，renderer 只读镜像   | 经 IPC `RemoteControlStateChanged` 推送                    |
| 手机端会话投影与水位                           | 手机浏览器 `conversationProjectionStore`（现有） | 本方案零改动                                               |

原则（继承 AGENTS.md）：relay 与 Main 不保存任务队列、快照；手机以 `web-remote-replayable` attachment 挂到窗口 Host，不另起 Agent / Local Host / 远程会话。

## 4. 总体架构

```
                        ┌────────────────────────────────────────────────┐
                        │  Relay Server（自研, relay.example.com, TS）     │
                        │  HTTPS: POST /api/rc/devices  /api/rc/bind      │
                        │  WSS:   /ws/desktop       /ws/phone             │
                        │  内存态: devices / sessions / mid→stream 路由    │
                        │  职责: 鉴权·票据·踢人·路由·帧转发（不解析帧）      │
                        └──────▲───────────────────────────▲─────────────┘
                               │ WSS 长连                    │ WSS
                               │ (register/issue/stream_*)   │ (透传 RPC 帧)
                               │ binary: [u32be sid][RPC]    │
              ┌────────────────┴───────────────┐   ┌───────┴─────────────────┐
              │ 桌面 App (Electron)             │   │ 手机浏览器                │
              │ Main:                          │   │ 静态页: packages/web     │
              │  remoteControlService (新增)    │   │  以 /remote base 构建     │
              │   ├ relay 客户端/心跳/重连       │   │  落地页 + bootstrap 分支  │
              │   ├ 票据请求 + 二维码 URL        │   │  (消费 VITE_..._RELAY_WS) │
              │   └ MessagePort 泵 ↔ stream     │   │ ChannelClient(现有) →    │
              │ Host(每窗口, 零改动):            │   │  replayable 投影(现有)    │
              │  AttachServicePort →            │   │ v2: RTCPeerConnection    │
              │  exposeServicesOnMessagePort    │   │  + DataChannel ISocket   │
              │ Agent CLI: 会话权威              │   └─────────────────────────┘
              └────────────────────────────────┘
   v2 直连: 手机 ◄── DataChannel(UDP 打洞, RPC 帧透传) ──► 桌面隐藏 RTC 窗口
           relay 退化为信令通道(STUN 列表下发 + offer/answer/ice 转发), 失败回退中转
```

核心桥接不变量：**手机管道在桌面侧被包装为普通 MessagePort attachment**。Main 为每个手机 stream 创建 `MessageChannelMain`，port2 随 `AttachServicePort`（scope=`local`、clientMode=`web-remote-replayable`）发给窗口 Host，port1 由 Main 桥到该 stream。与桌面 renderer 挂载（`packages/desktop/src/main/desktopRemoteSessions.ts:211-299`）完全同构，Host / renderer / Agent 零改动。

## 5. 凭证与票据契约（定死）

### 5.1 常量

```ts
const PROTOCOL_VERSION = 1; // 帧头 v 字段
const TICKET_TTL_MS = 10 * 60_000; // 短时票据有效期 10min（自动刷新模式）
const SESSION_TTL_MS = 2 * 60 * 60_000; // sessionToken 有效期 2h（活跃滑动续期）
const SESSION_IDLE_TTL_MS = 5 * 60_000; // 手机断开后 grace 等待 5min
const HEARTBEAT_PING_MS = 25_000; // relay → 连接方 WS 协议层 ping
const HEARTBEAT_TIMEOUT_MS = 60_000; // 无 pong 判死
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024; // 单帧上限（对齐 mobileRelayBytes 预算）
const P2P_SIGNAL_BUDGET_MS = 15_000; // WebRTC 信令总预算
const WS_CLOSE = {
  // 手机侧唯一带外控制通道（WS close code）
  KICKED: 4001, // 被新设备顶替
  DESKTOP_OFFLINE: 4002, // 桌面长连断开
  TICKET_INVALID: 4003, // bind 校验失败
  SESSION_EXPIRED: 4004, // sessionToken 过期/作废
  P2P_PROMOTED: 4005, // 手机主动升级 P2P 后关闭中转管道
  DESKTOP_DISCONNECTED: 4006, // 桌面主动断开当前设备（§21.4，票据仍有效可重连）
} as const;
```

> 设计约束：手机 ↔ relay 管道**只跑 RPC 帧（binary），零 text 混入**；对手机的全部控制语义经 HTTP 状态码或 WS close code 传达，保证现有 `wrapBrowserWebSocket → SocketProtocol` 链路零改动。

### 5.2 设备凭证（desktop ↔ relay，长期）

```ts
// 桌面首启生成并持久化于本地安全存储（Electron safeStorage 加密）:
deviceId = crypto.randomUUID(); // mid, 展示于二维码 URL
deviceToken = base64url(crypto.randomBytes(32)); // Bearer 凭证
// relay 侧仅存内存: devices: Map<mid, { tokenHash, name, appVersion, lastSeenAt }>
// 校验: sha256(请求 token) === tokenHash（不落明文）
// relay 重启丢失 → 桌面收到 401 自动重新 POST /api/rc/devices 注册（对用户无感知）
```

### 5.3 二维码票据（一次性，10min）

```ts
// 桌面请求: WSS /ws/desktop 控制帧 issue_session → relay 签发:
sid        = "s_" + base62rand(22);                                   // 随机会话 ID
issuedAt   = Date.now();                                             // t
accessHash = base64url(HMAC_SHA256(relaySecret, `zrc1:${sid}:${mid}:${issuedAt}`));
url        = `${WEB_REMOTE_BASE}?sid=${sid}&hash=${encodeURIComponent(accessHash)}`
           + `&t=${issuedAt}&mid=${mid}&name=${encodeURIComponent(deviceName)}&v=${APP_VERSION}`
           + `&ws=${encodeURIComponent(PUBLIC_WS_BASE)}`; // 2026-09-24 增补
// relay 内存: sessions[sid] = { state:"pending", mid, issuedAt, ... }

// 手机扫码后先经 HTTP 消费票据换取会话凭证:
POST /api/rc/bind  body: { sid, hash, t, mid }
  校验(全部通过才放行, 任一失败 → HTTP 401, code=TICKET_INVALID):
    a) Date.now() <= t + TICKET_TTL_MS
    b) constantTimeEqual(HMAC_SHA256(relaySecret, `zrc1:${sid}:${mid}:${t}`), hash)
    c) sessions[sid] 存在且 state === "pending"          // 一次性：首 bind 即消费
  成功 → sessionToken = base64url(randomBytes(32)), state → "ready"
         响应: { sessionToken, desktopName, relayWsBase }
```

### 5.4 会话凭证（sessionToken，2h 滑动）

```ts
// 手机 WSS 升级: /ws/phone?sid=<sid>&token=<sessionToken>
// relay 校验: sessions[sid] 存在 && sessions[sid].token === token && 未过期未作废
// 滑动续期: 每次手机 WS 消息刷新 expiresAt = now + SESSION_TTL_MS
// 断开 grace: 手机 WS 关闭时 disconnectedAt = now; SESSION_IDLE_TTL_MS 内重连直接复用 token,
//             超时 → session 作废, 后续重连收 WS_CLOSE.SESSION_EXPIRED
// 作废时机: 被踢 / 桌面主动断开 / relay 重启 / 自然过期
```

> 手机端 WS 基址解析顺序（2026-09-24 增补，目标：relay 域名迁移免重新构建手机页）：票据 URL `ws` 参数（须为 `wss?://`，非法即忽略）> 构建期 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` > 同源回退；bind 响应 `relayWsBase` 的运行时兜底语义不变。安全上 `ws` 参数仅指定 bind/WS 目的地，会话仍须持有 relay 签发的有效票据，指向伪造 relay 时 bind 必然 401。

## 6. Relay Server 设计

新增 `packages/relay-server`（Node ≥ 20，Hono + ws，复用 `@zcode/shared` 的 zod schema 风格）。单进程、全内存、不解析 RPC 帧。

### 6.1 端点清单

| 端点              | 方法 | 鉴权                                     | 用途                                                        |
| ----------------- | ---- | ---------------------------------------- | ----------------------------------------------------------- |
| `/api/rc/devices` | POST | 无（注册即获取）                         | 桌面注册/换发 deviceToken                                   |
| `/api/rc/bind`    | POST | 二维码票据                               | 手机消费票据换取 sessionToken                               |
| `/ws/desktop`     | WSS  | Bearer deviceToken（query `?mid&token`） | 桌面长连（控制 + 多路复用数据）                             |
| `/ws/phone`       | WSS  | sessionToken（query `?sid&token`）       | 手机数据管道（纯透传，仅 RPC 帧）                           |
| `/ws/signal`      | WSS  | sessionToken（query `?sid&token`）       | 手机信令管道（v2，仅 `RtcSignal` JSON，与数据管道物理分离） |

### 6.2 会话状态机（定死）

```
                 issue_session(桌面请求)
                      │
                      ▼
                 ┌─────────┐  bind 校验通过      ┌──────────────────┐
      ┌──创建────│ pending │────────────────────▶│ ready(有token)    │
      │          └────┬────┘                     └────────┬─────────┘
      │               │ TTL 到期 / 桌面 revoke            │ 手机 WSS 升级成功
      │               ▼                                  ▼
      │          ┌─────────┐   手机 WS 关闭(任何原因)  ┌───────────────┐
      │          │ closed  │◀──────────────────────── │ bound(1台手机) │
      │          └─────────┘                          └───────┬───────┘
      │               ▲     grace 超时(5min)                  │
      │               │     桌面长连断且未恢复                 │
      │               │     被新设备踢(§6.4)                  │
      │               │          手机 WS 关闭                  ▼
      │               │         ┌─────────┐  新票据绑定同 mid   │
      └───────────────┼────────│ grace   │────────(踢人)──────▶ closed
                      │        └────┬────┘
                      │             │ refresh 重连(token 复用, 5min 内)
                      │             ▼
                      │        回到 bound
                      └─ 任何状态遇 relay 重启 → 全部丢失(§6.7)
```

附加规则（定死）：

- `ready` 状态若 60s 内手机未完成 WSS 升级 → 回 `pending`（票据已消费，需桌面重新签发；relay 向桌面推 `session_issued` 失效通知）。
- `bound` 期间同一 sessionToken 重连（旧 WS 尚未判死）：relay 主动关闭旧 WS（同连接顶替，等价自踢），再绑定新 WS。

### 6.3 帧协议（定死）

**桌面 ↔ relay**（一条 WSS 多路复用）：

```ts
// 控制帧: WebSocket text, JSON
type DesktopControlFrame =
  // C → S
  | { v: 1; type: "register"; mid: string; token: string; name: string; appVersion: string }
  | { v: 1; type: "issue_session" }
  | { v: 1; type: "revoke_session"; sid: string }
  | { v: 1; type: "stream_accepted"; streamId: number } // 桌面确认 attachment 就绪
  | { v: 1; type: "stream_close_notify"; streamId: number } // 桌面侧 Host/attachment 关闭, 通知 relay 断开手机
  | { v: 1; type: "rtc_signal"; streamId: number; data: RtcSignal } // v2, 双向
  // S → C
  | { v: 1; type: "register_ok" }
  | { v: 1; type: "session_issued"; sid: string; url: string; expiresAt: number }
  | { v: 1; type: "session_invalid"; sid: string; reason: "consumed" | "expired" | "unknown" }
  | {
      v: 1;
      type: "stream_open";
      streamId: number;
      sid: string;
      phone: { ua: string; p2pCapable: boolean };
      transport: "relay";
    }
  | {
      v: 1;
      type: "stream_close";
      streamId: number;
      reason: "lost" | "kicked" | "phone_stop" | "p2p_promoted";
    }
  | { v: 1; type: "error"; code: string; message: string };

// 数据帧: WebSocket binary
// ┌────────────────────────┬──────────────────────────┐
// │ u32be streamId (4字节)  │ RPC 载荷(SocketProtocol帧)│
// └────────────────────────┴──────────────────────────┘
// streamId 由 relay 在 stream_open 时分配, 每条桌面连接内单调递增, 不复用
```

**手机 ↔ relay**：纯透传。手机发的 binary 原样转发到 `mid` 对应桌面连接（剥壳加 streamId）；桌面发的数据帧解出 streamId 后原样发给对应手机 WS。relay 对载荷零解析、零修改。

### 6.4 踢人语义（定死，单设备）

```ts
function onPhoneAuthenticated(sess /* state=ready */, newPhoneWs): void {
  const old = desktopRoutes.get(sess.mid)?.activeStream; // 该桌面当前手机管道(含 grace 中的)
  if (old && old.sid !== sess.sid) {
    // 1. 通知旧手机: WS close code 4001 KICKED
    old.phoneWs.close(4001, "superseded");
    // 2. 通知桌面: 关闭旧管道
    desktopSend(sess.mid, { type: "stream_close", streamId: old.streamId, reason: "kicked" });
    // 3. 旧会话彻底作废(graceToken 一并失效)
    sessions.get(old.sid)!.state = "closed";
  }
  bindStream(sess.mid, sess, newPhoneWs); // stream_open → 桌面
}
```

裁决唯一发生地是 relay；桌面收到 `stream_open` 时若本地已有活跃 attachment，也必须先 detach 旧的再 attach 新的（防 relay 与桌面视图的窗口期错位，双保险，见 §7.4）。

### 6.5 心跳、背压、限频

- 心跳：relay 对 `/ws/desktop` 与 `/ws/phone` 均用 **WS 协议层 ping/pong**（`HEARTBEAT_PING_MS` 间隔，`HEARTBEAT_TIMEOUT_MS` 无 pong 判死）。浏览器与 Node `ws` 库都自动回 pong，应用层零心跳帧——这是手机管道零污染的前提。
- 背压：relay 对每条连接维护转发缓冲计数，超过 `MAX_WS_MESSAGE_BYTES * 4` 时**直接断开该管道**（对齐仓库「溢出整批失败而非丢帧」哲学），两端走快照恢复，不做缓存补救。
- 单帧超限（> `MAX_WS_MESSAGE_BYTES`）→ 断开对应连接。
- 限频：`/api/rc/bind` 按 IP 10 次/分钟，失败按指数惩罚；WSS 升级失败率过高临时封禁 IP。

### 6.6 relay 不解析、不存储业务数据

转发面仅接触：控制帧 JSON 与不透明 binary。不落任何任务/快照/会话内容。日志只记 sid/mid/streamId/字节数与错误码，不记载荷。

### 6.7 无盘重启语义（定死）

relay 重启 → 内存全失 → 所有桌面长连断开重连时 `register` 被当作新设备（token 不匹配 → 401 → 桌面自动重新注册，但已签发 session 全部不存在）。行为契约：

- 桌面 `remoteControlService` 检测到 `register` 后收到 `error(code="device_unknown")` → 重新 `POST /api/rc/devices` → 重新 `issue_session` → **UI 状态回 pending 并刷新二维码**。
- 手机侧重连全部失败（4004）→ 落地页提示「连接已失效，请重新扫码」。
- v1 接受该体验（中转进程重启频率低），不做 session 持久化。

## 7. 桌面端设计

### 7.1 Main：`remoteControlService`（新增，唯一编排者）

位置：`packages/desktop/src/main/remoteControlService.ts`，由 Main 进程持有，生命周期 = App 生命周期。

```ts
type DesktopRemoteControlState =
  | { phase: "disabled" }                                     // 未开启(默认, 不出网)
  | { phase: "disabled"; lastError: string }                  // 出错关闭
  | { phase: "pending";  sid: string; url: string; expiresAt: number }  // 二维码展示中
  | { phase: "waiting";  since: number }                      // 手机断开, grace 倒计时
  | { phase: "connected"; streamId: number; phone: { ua: string }; transport: "relay" | "p2p";
      since: number };

// 与 relay 的连接生命周期:
//   App 启动 → disabled(不出网, 零连接)
//   用户开启远控 → ensureRelayConnection():
//     若无 deviceToken 或收到 401/device_unknown → POST /api/rc/devices 注册(安全存储)
//     WSS /ws/desktop → register → issue_session → pending
//   relay 断开 → 指数退避重连(1s,2s,4s..max 30s) → 重新 register:
//     旧 sid 仍 pending → 复用(仅刷新 UI 倒计时)
//     旧 sid 已 bound/waiting → 重新 issue_session → UI 回 pending 并提示「连接中断, 需重新扫码」
//   用户关闭远控 / App 退出 → revoke_session + 关闭全部 stream → disabled

// stream 事件编排:
onControlFrame(frame):
  case "session_issued":  state = pending; pushStateToRenderer()
  case "session_invalid": state = pending(重新 issue); pushState()
  case "stream_open":     attachPhoneStream(frame)            // §7.3
  case "stream_close":    detachPhoneStream(frame.streamId,
                            reason === "lost" ? "grace" : "immediate")  // §7.4
```

### 7.2 `attachLocalWorkspaceSessionHost` 契约（新增于 `desktopRemoteSessions.ts`，与既有 `attachRemoteWorkspaceSessionHost:832-892` 平行）

```ts
function attachLocalWorkspaceSessionHost(params: {
  webContentsId: number;
  clientMode: "web-remote-replayable"; // 字面量类型锁定, 编译期不可传其他值
}): { attachmentId: string; port: MessagePortMain };

// 前置校验(fail-closed, 任一失败抛出且不开端口):
//   WINDOW_MISSING   webContentsId 无对应窗口
//   HOST_NOT_READY   该窗口 Host 进程未就绪(windowHostProcessMap 无条目)
// 行为:
//   1. const { port1, port2 } = createMessageChannel()
//   2. 向 Host 发 HostMessageTypes.AttachServicePort {
//        attachmentId, clientMode: "web-remote-replayable",
//        scope: { kind: "local" }   // 与 renderer reload 复挂同构(desktopWindowLifecycle.ts:148-157),
//                                   // schema: validation.ts:210-221; 活跃 workspace 真值由 Host 的
//                                   // activeServices 拥有, Main 不做三元组校验(状态所有权原则)
//      } 并转移 port2
//   3. 返回 port1 交调用方桥接
//   supersede: 同一时刻仅一个 mobile-remote attachment(单设备);
//              新 attach 自动 DetachServicePort 旧的(踢人双保险)
//   失败信号: Host 无 ready 回执; scope 解析失败时 Host fail-closed 关闭 port,
//            泵以 port close 为唯一失败信号 → stream_close_notify → relay 断开手机管道
```

> 实施期修订记录：原设计的 `WORKSPACE_MISMATCH` 三元组校验与 15s ready 超时被移除。原因：`windowHostAttachmentScopeSchema` 的 local kind 本就只有 `{kind:"local"}`（workspace 真值归 Host 所有，Main 侧校验属重复状态）；Host 对非 renderer attachment 不发 ready 回执，新增回执会破坏「Host 零改动」不变量。port close 即 fail-closed 信号，语义等价且更简单。

````

### 7.3 MessagePort 泵（`MobileStreamBridge`，Main 内，分帧翻译器）

```ts
class MobileStreamBridge {
  attach(streamId: number): void {
    const { attachmentId, port } = attachLocalWorkspaceSessionHost(activeWindowWebContentsId());
    // 上行 Host → 手机: MessagePort 消息(payload, 无帧头) → 补 13 字节 SocketProtocol Regular 帧头 → WS binary
    port.on("message", (e) => relayConn.sendBinary(streamId, frameWithHeader(e.data)));
    port.on("close", () => relayConn.sendControl({ type: "stream_close_notify", streamId }));
    // 下行 手机 → Host: WS binary(13B 帧头 + payload) → 剥帧头 → port.postMessage({ data: payload })
    relayConn.onBinary(streamId, (buf) => port.postMessage({ data: stripFrameHeader(buf) }));
    relayConn.sendControl({ type: "stream_accepted", streamId });
    this.active = { streamId, attachmentId, port };
  }
  detach(streamId: number, mode: "immediate" | "grace"): void {
    // immediate: 立即 DetachServicePort + port.close()
    // grace:    5s debounce 后执行(吸收 WS 抖动); 期间同 sid 新 stream_open 到来则取消
  }
}
````

分帧翻译契约（实施期定稿，替代原「消息形状对齐」开放点）：

- 手机侧链路是 `SocketProtocol over WS`：每条 binary WS 消息 = 13 字节帧头（`type(1)=Regular + id(4) + ack(4) + length(4)`，`packages/rpc/src/protocol.ts:184-207`）+ 消息体。
- Host 侧是 `MessagePortProtocol`：MessagePort 天然有消息边界，**每条消息 = 消息体本体（Uint8Array），无帧头**（`protocol.ts:361-397`）。
- 因此泵必须逐消息做「剥/补 13 字节帧头」的翻译，不能当字节管道转发；`type` 固定写 `Regular`，id/ack 写 0（非 persistent 链路不使用）。
- Host 侧可能 postMessage 流控对象（`{ __zcodeRpcControl: "connection-flow-v1", state }`，非 Uint8Array）：v1 泵丢弃并记 debug 日志（手机链路不启用协议级流控，RPC 层 `v4/connection/flow` 不受影响）。
- Host 侧 `exposeServicesOnMessagePort` 的 per-attachment overrides（clientMode facade、share 拒绝、媒体 inline 等）对手机 attachment 自动生效，泵不感知。

````

### 7.4 踢人在桌面侧的行为（双保险）

```ts
onStreamOpen(frame):
  if (bridge.active && bridge.active.streamId !== frame.streamId) {
    bridge.detach(bridge.active.streamId, "immediate");   // 先清旧
  }
  bridge.attach(frame.streamId);
  state = { phase: "connected", transport: "relay", ... }; pushState();
````

### 7.5 IPC 与 UI

新增 `PlatformChannels`（`packages/shared/src/channels.ts`）：

```ts
RemoteControlGetState; // renderer 拉取当前 state
RemoteControlStart; // 开启(进入 pending, 签发票据)
RemoteControlStop; // 关闭(revoke + 断开)
RemoteControlRefreshTicket; // 重新生成二维码
RemoteControlStateChanged; // Main → renderer 状态推送(唯一写路径, renderer 只读镜像)
```

UI（`packages/ui`）：`WorkspaceSidebarFooter.tsx` 用户菜单与设置按钮之间新增手机图标按钮（`lucide` `Smartphone`）→ 弹窗渲染状态机：

```
disabled ──开启──▶ activating ──票据签发──▶ pending(二维码+TTL倒计时)
pending  ──手机 bind+连接──▶ connected(设备UA摘要+transport徽标+断开按钮)
pending  ──TTL 到期──▶ expired(重新生成) ──点击──▶ pending
connected──手机断开──▶ waiting(「等待设备重连 mm:ss」, 5min) ──重连──▶ connected
waiting  ──超时──▶ pending(自动重签票据并提示重扫)
任何     ──用户断开/出错──▶ disabled
```

二维码渲染：`qrcode` 依赖已在 `packages/ui/package.json:66`，补 import 使用。renderer 不接触 sid/hash 明文之外的任何凭证；票据 URL 即二维码内容。

## 8. 手机端设计

### 8.1 构建与部署

- `packages/web` 以 base `/remote/` 构建两次产物（或一次构建 + 路由变量），部署至 `m.example.com`（静态托管，Caddy 终止 TLS）。
- 构建期注入：`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL = wss://relay.example.com`（env 声明已存在于 `packages/web/src/env.d.ts:17`，此前零消费，本方案为其唯一消费方）。HTTP 基址由其推导（`wss:` → `https:`，即 `RELAY_HTTP_BASE`），bind 响应中的 `relayWsBase` 与之一致并作为运行时兜底。
- 落地页与远控页共用 `main.tsx` 入口，按 §8.2 分支。

### 8.2 bootstrap 分支（`resolveWebBootstrap` 扩展，定死）

```ts
async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const q = new URLSearchParams(location.search);
  const sid = q.get("sid");
  if (!sid) return existingDefaultPath(); // 现有 /ws 路径, 原样保留

  // —— 远控路径 ——
  const landing = await showLanding({
    // 展示 desktopName/name 参数, 用户点「连接」
    desktopName: q.get("name") ?? "未知设备",
  });
  const bind = await fetch(`${RELAY_HTTP_BASE}/api/rc/bind`, {
    method: "POST",
    body: JSON.stringify({ sid, hash: q.get("hash"), t: +q.get("t")!, mid: q.get("mid") }),
  });
  if (!bind.ok) return bootError("二维码已过期或无效，请在电脑上重新生成");

  const { sessionToken, relayWsBase } = await bind.json();
  const wsUrl = `${relayWsBase}/ws/phone?sid=${sid}&token=${sessionToken}`;
  return { wsUrl, remoteControl: { sid, sessionToken } }; // 交给 §8.3 连接器
}
```

### 8.3 重连连接器（`RemoteControlSocket`，唯一 WS 生命周期管理者）

```ts
class RemoteControlSocket /* 实现 ISocket, 下游接现有 connectViaWebSocket 的消费方式 */ {
  // 状态机:
  // connected ──onclose──▶ reconnecting ──成功──▶ connected
  //                │            │ SESSION_EXPIRED(4004) / TICKET 无效 → dead(提示重扫)
  //                │            │ KICKED(4001) → kicked(提示「已在其他设备连接」)
  //                │            │ DESKTOP_OFFLINE(4002) → 继续退避重试(≤ grace 5min)
  //                └─ v2: 优先尝试 P2P(§9), 失败回退本路径
  //
  // 重试策略: 1s,2s,4s,8s,max 10s 指数退避 + 抖动; 重连 URL 始终用同一 sessionToken(grace 语义)
  // 上层恢复: 每次拿到新 WS → 交由现有 conversationProjectionStore.subscribe(base 水位)
  //           → ACK resume 续增量 / snapshot 全量(现有代码, 零改动)
}
```

## 9. v2 P2P 直连

### 9.1 载体与前提

- 手机端：浏览器原生 `RTCPeerConnection` + `createDataChannel`（ordered/reliable）。
- 桌面端：**隐藏 `BrowserWindow`（show:false）+ 最小 preload RTC 桥**，经 IPC 由 `remoteControlService` 驱动。不引入原生模块（node-datachannel），规避跨平台打包/签名负担。窗口常驻内存开销 ~30-50MB，在「开启远控」时才创建。
- 工具窗口不进系统窗口表面的手段按平台区分：`skipTaskbar: true`（Windows/Linux 选项，macOS 忽略）承担任务栏隐藏；`setHiddenInMissionControl` 为 **macOS 专属 API**，必须以 `process.platform === "darwin"` 守卫——非 macOS 平台 `BrowserWindow` 上不存在该方法，未守卫调用会在窗口创建时同步抛 `TypeError` 崩溃主进程（2026-09-25 Linux amd64 真机：手机点「开始连接」即弹主进程错误框，P2P 协商无法开始）。
- 工具窗口加载共享 preload 时会随启动发 `WindowControlsOverlayReady`，main 对**发送方窗口**做窗控同步；win32 下对创建时未带 `titleBarOverlay: true` 的窗口调 `setTitleBarOverlay` 会同步抛 `TypeError: Titlebar overlay is not enabled` 崩主进程（2026-09-25 Windows 真机：手机连接成功瞬间弹主进程错误框）。win32 原生 overlay 同步因此改为**登记制**（`desktopWindowTitleBarOverlay.ts`，Electron 41 无 `getTitleBarOverlay()` 查询 API）：仅创建参数带 `titleBarOverlay: true` 并登记的窗口（更新状态窗）允许 `setTitleBarOverlay`，主窗口走自绘窗控分支，其余窗口（RTC 工具窗）一律跳过。
- STUN：公共 STUN 列表由 relay 持有（运维可配置替换），在手机建立 `/ws/signal` 时经 `rtc_signal(config)` 直接下发，不依赖桌面版本；不部署 TURN——打洞失败即留在中转链路（永久兜底），后续需要时再加 coturn。

### 9.2 信令通道与信令帧（定死）

**约束冲突与解法**：手机数据管道（`/ws/phone`）必须零 text 混入（§5.1 设计约束），而 WebRTC 信令需要双向 JSON 通道。解法：**手机在 bind 成功后并行建立第二条轻量 WSS `/ws/signal?sid&token`**，仅承载 `RtcSignal` JSON（text），与数据管道物理分离、互不污染；relay 将其与桌面 stream 关联后，在桌面长连上以 `rtc_signal` 控制帧透传。数据管道约束保持不变。

```ts
// /ws/signal 与桌面 rtc_signal 控制帧共用的信令载荷:
type RtcSignal =
  | { kind: "config"; iceServers: { urls: string[] } }
  | { kind: "p2p_request" } // 手机 → 桌面: 声明支持 WebRTC
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "reject"; reason: string };
```

### 9.3 建立与切换时序（定死：P2P 切换 = 一次受控重连，不做无缝切换）

```
手机                          relay                         桌面(Main/RTC窗口)
 │ WSS /ws/signal 建立          │                              │
 │◀─ rtc_signal(config) ───────│ (relay 注入 STUN 列表)        │
 ├─ rtc_signal(p2p_request) ───▶├─ rtc_signal ────────────────▶│ 检查 phone.p2pCapable
 │                              │                              │ 创建 hidden RTC window
 │                              │                              │ pc=new RTCPeerConnection(STUN)
 │                              │                              │ dc=pc.createDataChannel("zrc",{ordered:true})
 │◀──────────────── rtc_signal(offer) ─────────────────────────┤
 │ pc=new RTCPeerConnection; setRemote(offer)                   │
 │ pc.ondatachannel = dc                                        │
 ├─ rtc_signal(answer) ────────▶├─ 转发 ──────────────────────▶│ setRemote(answer)
 │◀═════════════ trickle ICE(rtc_signal ice ×N, 双向) ═════════▶│
 │                              │                              │ dc.onopen:
 │ dc.onopen:                   │                              │   attachLocalWorkspaceSessionHost
 │   新 ChannelClient(ISocket=   │                              │   (transport:"p2p", 新 attachment)
 │   wrapDataChannel(dc))        │                              │
 │   hello → subscribe(base 水位) │                             │
 │   ACK resume 成功:            │                              │
 │     close /ws/phone           │──stream_close(p2p_promoted)▶│ detach 旧 relay attachment
 │     (close code 4005)         │                              │ state.connected.transport="p2p"
 │   ACK snapshot / 失败:        │                              │
 │     close dc, 留在 WS 中转     │                              │
 └── 信令总预算 P2P_SIGNAL_BUDGET_MS=15s, 超时双方放弃, 保持中转 ──┘
```

关键点：手机在 DataChannel 上完全重放「断线重连」路径（新 ChannelClient → hello → subscribe(base) → resume），成功后才放弃中转管道；失败即弃 P2P 留在 WS。桌面侧新旧 attachment 短暂并存由 supersede 规则收敛（§7.2）。

### 9.4 保活与回退（定死）

- 不为 P2P 增设应用层心跳：活性由 RPC 请求天然探测；`dc.onclose` / `pc.connectionState === "failed" | "disconnected"` 为回退触发器。
- 手机侧：任一 RPC 请求 30s 无响应，或 DC 断 → 关闭 DC → 走 §8.3 连接器回退 WSS `/ws/phone`（sessionToken 复用，grace 语义）。
- 桌面侧：RTC 窗口上报连接失败 → detach p2p attachment，等手机从中转回来；隐藏窗口保留复用，连续 3 次打洞失败后 10 分钟内不再尝试 P2P（此后新 stream 直接中转）。

## 10. 断线重连矩阵（验收基准）

| 断点                   | 检测                       | relay 行为                                       | 桌面行为                                             | 手机行为                                       | 最终恢复                                         |
| ---------------------- | -------------------------- | ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| 手机网络抖动/切换      | relay 协议层 pong 超时     | session→grace(5min)，`stream_close(lost)` 给桌面 | 5s debounce 后 detach                                | 自动退避重连（同 token）→ 重新 subscribe(base) | ACK resume 续增量，≤5min 内用户无感              |
| 手机被踢（新设备接入） | §6.4                       | 旧 WS close 4001，session 作废                   | 收 `stream_open`，detach 旧 + attach 新              | 旧手机展示「已在其他设备连接」                 | 新设备正常使用                                   |
| 桌面网络断开           | relay 判死桌面连接         | 全部手机 WS close 4002，sessions→grace           | 指数退避重连 + re-register + 重签票据                | 收 4002 → 持续退避重试（≤5min）                | 桌面回来 + 手机重试成功 → 重新绑定；>5min 需重扫 |
| 桌面 App 退出          | 同上                       | 同上                                             | —（进程已死）                                        | 同上                                           | App 重启后重新生成二维码                         |
| relay 重启             | 连接全断                   | 内存全失                                         | `device_unknown` → 重注册 + 重签票据 → UI 回 pending | 全部重试失败(4004) → 提示重扫                  | 用户重新扫码（v1 接受）                          |
| 二维码超时未扫         | relay TTL                  | pending→closed，`session_invalid(expired)`       | UI → expired/重签                                    | 扫开时 bind 401                                | 重新生成二维码                                   |
| P2P 通道断             | dc.onclose / 请求 30s 超时 | 不涉及（已旁路）                                 | detach p2p attachment                                | fallback WS 重连                               | resume 续传                                      |
| 弱网（高延迟丢包）     | 帧预算/背压超限            | 断开该管道（不缓存）                             | detach                                               | 退避重连 + snapshot 全量                       | 快照恢复（对齐「断档不猜」哲学）                 |

切换 workspace / 关闭窗口时（桌面侧主动）：`remoteControlService` 监听窗口激活 workspace 变化 → 当前 attachment 因 `WORKSPACE_MISMATCH` 失效 → 断开当前 stream（`revoke` 不需要，直接 close phone）→ 手机收到重连后绑不上 → 展示「电脑端会话已变更，请重新连接」→ 桌面 UI 回 pending 重签票据。v1 接受此体验。

## 11. 安全设计

1. 全链路 TLS（HTTPS/WSS，Caddy 终止）。
2. 票据 HMAC 常数时间比较；票据一次性（pending → ready 即消费）；TTL 10min。
3. 长期凭证（deviceToken）不出现在 URL/二维码；仅存安全存储与 relay 内存（哈希）。
4. `bind` 与 WSS 升级按 IP 限频，防 hash 爆破（HMAC-SHA256 256-bit，实际不可爆破，限频为纵深防御）。
5. relay 不解析载荷、不落盘、日志无业务内容（§6.6）。
6. （v3 预留）E2E 加密：由 sid+hash 派生对称密钥加密 RPC 帧，relay 彻底零知识；本版不实施但信封预留版本号 `v` 字段以便升级。

## 12. 验收场景

1. **首次配对**：桌面点手机图标 → 出码（URL 含 sid/hash/t/mid/name）→ 手机扫码 → 落地页显示设备名 → 连接 → 会话列表与桌面一致；手机发消息，桌面实时可见；桌面发消息，手机实时收到。
2. **票据一次性**：同一二维码第二台手机打开 → `bind` 401 → 提示失效。
3. **踢人**：A 已连接 → 桌面刷新二维码 → B 扫码连接 → A 立即收到 4001 提示页，B 正常使用，桌面 UI 显示 B。
4. **断网重连**：A 开飞行模式 30s → 恢复 → 自动重连成功，历史完整、新消息从断点续上（resume，无重复消息——commandId 幂等保证）。
5. **grace 超时**：A 断开超 5min → 重连被拒（4004）→ 提示重扫；桌面 UI 先经历 waiting 后自动回 pending 重签。
6. **桌面断网**：拔网线 1min → 手机提示桌面离线并自动重试 → 桌面恢复网络 → 手机自动续上。
7. **P2P**：双方 NAT 可打洞时连接建立 → relay 观测该 stream 流量归零、桌面 transport 徽标显示 p2p → 手动断 DC（如关 Wi-Fi）→ 自动回退 WS 并 resume。
8. **P2P 失败回退**：强制 UDP 全禁 → 15s 信令预算超时 → 留在中转，功能不受损。
9. **安全**：篡改 hash / 过期 t / 重放已消费票据 / 伪造 sessionToken → 全部拒绝，且限频生效。
10. **弱网**：500ms RTT + 丢包下消息不丢不重；帧超限断开后走 snapshot 恢复。
11. **默认不出网**：`disabled` 状态桌面与 relay 零连接、零请求（对齐 specs/update/update-check.md 的隐私先例）。
12. **边界**：手机端 replayable 禁用能力生效（无分屏 pane、无 Provider Provisioning 写入、会话分享拒绝）——现有 connection scope 行为，回归验证即可。

## 13. 实施计划

| 里程碑            | 内容                                                                                                                                  | 交付判据           | 工作量    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------- |
| M1 中转链路端到端 | relay-server（端点+状态机+帧转发）、桌面 remoteControlService+attachLocal+泵+IPC、手机 bootstrap 分支+落地页、`/remote` base 构建部署 | 验收 1、2、11      | 8–10 人天 |
| M2 生命周期完整   | 踢人、grace、TTL、断线矩阵全场景、relay 重启语义                                                                                      | 验收 3、4、5、6、9 | 3–4 人天  |
| M3 UI 打磨与回归  | 弹窗状态机、waiting/expired 体验、replayable 能力回归                                                                                 | 验收 12            | 2–3 人天  |
| M4 P2P 直连       | `/ws/signal` 信令、隐藏 RTC 窗口、DataChannel ISocket、切换即重连、回退与冷静期                                                       | 验收 7、8          | 5–8 人天  |
| M5 稳定性收尾     | 弱网与长稳测试、日志与遥测、部署文档                                                                                                  | 验收 10 + 长稳 24h | 2–3 人天  |

合计 20–28 人天。依赖顺序：M1 → M2 → M3 → M4 → M5；M4 仅依赖 M1 的信令通道扩展，可与 M3 并行。

## 14. 风险与开放问题

- **MessagePort 消息形状对齐**（M1 最大不确定点）：泵与 Host 侧 MessagePort ISocket 的载荷形状必须实测对齐（§7.3），实现时先写桌面侧单测（fake port ↔ fake stream 双向字节一致性）。
- **MessagePortMain 无原生背压**：v1 以「缓冲监控 + 超限断流走快照」覆盖；若实测桌面→手机大流量场景劣化，v2 引入 Host 侧 flow（`v4/connection/flow` saturated 通知已存在）联动。
- **隐藏 RTC 窗口内存**：~30-50MB 常驻；仅在开启远控时创建，App 退出即销毁。若不可接受，备选 node-datachannel（承担原生模块跨平台打包成本）。
- **relay 单点**：v1 单进程单机；带宽上限即中转上限（P2P 生效后多数流量旁路）。横向扩展需引入 sticky 路由（按 mid 分片），明确为 v3+。
- **开放问题**：手机页 PWA/添加到主屏体验；桌面多显示器多窗口时「当前激活窗口」的判定规则（v1 取 focus 窗口，无 focus 取最后活跃）；二维码在预览/正式 flavor 的域名与开关策略（对齐 `ZCODE_PRODUCT_FLAVOR`）。

## 15. 实施修订记录（v1+v2 落地后补记）

实现与本 spec 的差异，全部已随代码落地并回归：

1. **§7.3 泵的流控对象**：Host 侧 MessagePortProtocol 发送侧以 `ArrayBuffer` 下发、接收侧只接受 `Uint8Array`（`packages/rpc/src/protocol.ts:361-397`）——泵的下行投递固定 `new Uint8Array(payload)`，上行对 `ArrayBuffer`/TypedArray 视图归一化后补 13 字节 Regular 帧头；帧头 `length` 字段与实际长度强校验，不符即断管道（fail-fast）。
2. **§7.1 重连时的票据策略**：relay 断开重连后 `register_ok` 时**不主动重签**——pending 期间旧票据在 relay TTL 内仍有效（同码可扫），waiting 超过 grace（5min）才重签；从未收到 `register_ok` 即断开视为 relay 重启，清除本地 deviceToken 自动重新注册（§6.7）。
3. **§8 手机重连语义**：开源实现采用「重连后整体重建」——新 WS 连接 + Root 重挂载 + 全量 snapshot 投影（spec §10 的 snapshot 恢复路径）。水位 `resume` 增量续传依赖官方 v4 手机构建未开源的投影持久化，本实现以 snapshot 语义达到同等验收结果（历史完整、无重复消息）。
4. **§9 P2P 数据面协议**：直连两端统一使用 `MessagePortProtocol` 语义（消息边界、无 13B 帧头）——手机端 DataChannel 直接适配为 `MessagePortLike`；桌面端把 Host attachment 的 `MessagePortMain` **整体转移进隐藏 RTC 窗口**，窗口内桥接 dc ↔ port，Main 零数据面工作（信令与编排除外）。P2P 路径不经过分帧翻译（泵仅服务中转路径）。
5. **§9.1 桌面 STUN 列表**：桌面侧使用 `ZCODE_REMOTE_CONTROL_STUN_URLS` 环境变量（默认公共 STUN）；relay 注入的 `config` 仅作用于手机端。
6. **§6.1 技术选型**：relay 用 Node 内置 `http` + `ws` 实现（未引 Hono），零第三方运行时依赖；CORS 仅对 `/api/rc/*` 放行（票据即凭证、无 cookie）。
7. **新增通道**：`PlatformChannels.RemoteControlRtcCommand/Event`（Main ↔ 隐藏 RTC 窗口）；MessagePort 经 preload `window.postMessage` transfer 进窗口（与 ScopedServicePort 同模式，contextBridge 不透传端口）。
8. **测试基线**：relay-server 29 例（单测 + 真实 WS/HTTP E2E）、desktop 21 例（泵/凭证/服务状态机/RTC 控制器）、E2E 双场景（真实 RPC 管道含踢人与 grace 重连；P2P 升级含 4005 退役），全部通过；`pnpm typecheck` 通过，desktop 完整 tsc 构建存在与本次无关的存量错误（`window.zcode` 全局类型等，基线未变）。

## 16. Code review 修订记录（第一轮 review 后）

独立 review 发现并已修复的问题（全部有对应回归测试或复验）：

**P0**：① main 进程 ESM 下 `__dirname` 崩溃 → 改 `import.meta.dirname` + 正确的 preload 产物路径 `index.cjs`；② RTC 窗口命令通道未订阅（P2P 必失败）→ 胶水脚本注入后主动调用 `onRemoteControlRtcCommand` 完成订阅；③ 胶水 dc→port 方向 post `ArrayBuffer` 被 Host 丢弃 → 统一包装为 `Uint8Array`；④ relay `stream_close` 全表按 streamId 扫描在多桌面共享 relay 时误路由 → effect 携带 `sid` 按 sid 路由（streamId 每桌面连接独立分配、全局不唯一）；⑤ 手机重连 catch 一律 re-bind 把有效会话打成 expired 终态 → 仅首连（无 sessionToken）才允许 re-bind 判过期。

**P1**：① P2P 升级后无回退 → `P2pNegotiation.onDisconnected`（dc close/pc failed）触发复用 §8.3 重连器回中转；② `stop()` 不拆 P2P → service 新增 `onStopped` 监听，wiring 接 `controller.dispose()`；③ relay 未配置时 UI 出现死入口 → IPC 恒注册 + `GetState` 返回 `enabled` 标志，hook 按 enabled 门控（fail-closed）；④ relay sessions 只标 closed 不回收 → sweep 增加\_CLOSED 会话 10min 保留后物理删除；⑤ E2E 句柄悬挂进程不退 → finally 清理 pump/connection/MessageChannel + test 脚本 `--test-force-exit`。

**P2**（已修）：心跳按 spec 60s 判死（lastSeenAt 窗口）；`session_invalid` 比对 sid 防迟到二次重签；waiting 所有进入路径统一 arm 5min 重签兜底；`RelayConnection.onClosed` latch 防双发；清 deviceToken 需连续两轮未注册（容忍首网络瞬断）；`activeSidByStreamId` 严格比对 streamId；`bindTicket` 先验 HMAC 再判 TTL（防伪造 t 作废票据）；bind 响应 `relayWsBase` 作为运行时兜底。

**P2（有意取舍，记录不改）**：safeStorage 不可用时 deviceToken 明文降级落盘（丢失即重新注册，风险可接受）；P2P 回退未做 30s 请求级看门狗（dc/pc 断开事件已覆盖主要场景）；§7.3 detach 无 5s debounce（与手机侧整体重建语义自洽）；relay 对桌面连接双发 register_ok（桌面幂等）。

## 17. 真机验证与部署增强记录（2026-09-24）

真机验证（德国 VPS relay + 本机 dev App + 自动化浏览器手机）全部通过：注册/出票/落地页/主界面与工作区数据加载/票据一次性（二次 bind 401 + 失效提示页）/断线检测/waiting 5min 自动重签/iptables 闪断 5s 后手机页内自动重连恢复（grace token 复用 + 桌面退避重连 + 重新 attach）/P2P 协商失败静默降级（`signal-budget-exceeded`，中转不受影响）。

部署增强：

1. `entry.ts` 顶层 await 收进 `main()`——esbuild `--format=cjs` 打包部署必需；relay 以零依赖单文件部署（Node ≥ 18）。
2. 端点解析增加配置文件 fallback：环境变量 > `~/.mikiko/remote-control.json`（`enabled`/`relayWsUrl`/`relayHttpUrl`/`stunUrls?`/`deviceName?`，启动自检与开关语义见 §21.10）> 关闭。打包版 App 免环境变量启用远控；配置文件同样受「双端点成对」约束，缺失即零出网（入口仍展示，`disabledReason="unconfigured"`）。
3. 手机页静态资源建议部署至 Cloudflare Pages（`--base=/` 专属域，`?sid=` 入口与路径无关），票据 URL 的 `RELAY_WEB_REMOTE_BASE` 指向该域；relay 仅承载 WS 与 bind（小流量）。

## 18. Cloudflare 部署结论（2026-09-24 真机定稿）

**最终架构：静态 Pages + WS 走 Cloudflare Tunnel（不在 Worker 里泵 WS）。**

```
手机浏览器
  ├─ 静态资源: https://<project>.pages.dev（Pages CDN，实测主 JS 2.5MB/s vs 源站直连 23KB/s）
  └─ 数据面:   wss://<tunnel>.trycloudflare.com/ws/phone（CF 边缘 → cloudflared → relay:8080）
桌面 App ──────────────── ws://<relay-host>:8080/ws/desktop（直连，不走 CF）
```

关键结论（真机验证）：

1. **Workers/Pages Functions 不能 fetch 裸 IP 源站**（`error code: 1003`，且与端口无关；8787/8080 均拒）。回源必须域名。
2. **Worker 内泵 WS 的方案不可用**：升级/路由/踢人等控制面全部正常，但 Host→手机方向的 RPC 帧无法穿过 Worker WebSocket 泵（ChannelClient 等不到服务端 Initialize，页面空转）。改为 WS 直连隧道域名后立即恢复。
3. relay 必须监听 **8080**（cloudflared 回源 localhost 任意端口均可；8080 同时释放了原静态托管端口）。限频键支持 `x-forwarded-for`（经 CF 代理时透传真实 IP）。
4. **trycloudflare 快速隧道域名随机且进程重启会变**——测试可用；生产建议：自有域名 + named tunnel（`cloudflared tunnel login` 交互授权，当前 wrangler OAuth scope 不含 tunnel 权限），并把 `RELAY_PUBLIC_WS_BASE`/构建注入的 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 指向固定域名。
5. 桌面端点经 `~/.mikiko/remote-control.json` 配置（§17），打包 App 免环境变量；票据 URL 由 relay 的 `RELAY_WEB_REMOTE_BASE` 生成指向 Pages 域。

真机复验（最终架构）：落地页秒开 → 连接 → 主界面与真实任务列表渲染；期间 relay 重启（token 失效自动重注册）、桌面重启均自动恢复。

## 19. 自有域名定稿（mikiko.ai，2026-09-24）

trycloudflare 随机域名升级为固定子域（§18 的生产建议落地）：

```
手机浏览器
 ├─ 静态:  https://remote.mikiko.ai（Pages 自定义域，CNAME → mikiko-remote.pages.dev，橙云）
 └─ 数据:  wss://ws.mikiko.ai/ws/phone（named tunnel `mikiko-relay`，CNAME → <tunnel-id>.cfargotunnel.com，橙云）
桌面 App ─ wss://ws.mikiko.ai/ws/desktop（与手机同域走 CF 边缘，抗直连抖动；IP 直连保留为配置注释选项）
```

服务器组件全部 systemd 化：`mikiko-relay`（relay:8080）与 `mikiko-tunnel`（cloudflared named tunnel，token 模式）。quick tunnel 已退役。

建设过程要点：wrangler OAuth 实际具备 Pages 域绑定与 cfd_tunnel 写权限（whoami 的 scope 列表不全），但**无 dns_records 写权限**——DNS 记录需 dash 手动创建或用户授权；`cloudflared tunnel route dns` 的 token 模式不支持（需 cert.pem）。

## 20. 部署产物与 CI（2026-09-24）

规范部署文档（唯一事实源）：`packages/relay-server/docs/deploy-server.md`（服务器直连模式）与 `packages/relay-server/docs/deploy-cloudflare.md`（Cloudflare 边缘模式：Pages 静态 + named tunnel WSS；relay 进程始终运行在自有服务器，Worker 泵 WS 不可行的结论见 §18）。`packages/relay-server/deploy/` 存放两模式共用的模板（systemd 单元、env 示例、Caddyfile、Pages 部署脚本），文档与模板不一致时以文档随模板同步修订为准；README 只保留概览。

打包命令：`pnpm --filter @zcode/relay-server run build:bundle` 产出零依赖单文件 `dist/relay.cjs`（esbuild CJS，Node ≥ 18）；`pnpm --filter @zcode/web run build:remote-pages` 产出**域名无关**的手机页（`--base=/`，不注入构建期 WS 域名，运行时经票据 `ws` 参数定位 relay，见 §5.3 增补）。

Release 流水线（`.github/workflows/release-desktop.yml`）新增 `relay` job，随桌面安装包一并组装、发布两种部署产物：

- `relay-server-deploy`：`relay.cjs` + systemd/env/Caddy 模板 + `docs/deploy-server.md`；
- `relay-cloudflare-deploy`：`relay.cjs` + 手机页静态产物（`web/`）+ Pages/tunnel 模板与部署脚本 + `docs/deploy-cloudflare.md`。

## 21. 体验批次修订（2026-09-24，票据多设备 + 断开语义 + 手机页 UX）

本节为一批体验修订的唯一契约，冲突处以本节为准。

### 21.1 票据长效与多次使用（修订 §5.3/§6.2）

1. `issue_session` 控制帧（C→S）新增可选字段 `persistent?: boolean`：
   - 缺省/false = **短时票据**：TTL `TICKET_TTL_MS`（10min），HMAC 载荷前缀 `zrc1:`（原语义）。
   - true = **长效票据**：不设 TTL（除非被替换/撤销否则永不过期），HMAC 载荷前缀 `zrc1l:`。
2. `session_issued`（S→C）的 `expiresAt` 改为 `number | null`（null = 长效）。
3. **多次使用**：同一票据在有效期内允许任意次 bind（状态 pending/ready/bound/grace 均可）；每次 bind 重铸 `sessionToken`（旧 token 立即失效），`readyDeadline` 重置。原「一次性：首 bind 即消费」作废。
4. **单活票据**：同一桌面同时只保留一张活票据。`issueSession` 时 relay 将同 mid 的旧票据会话关闭——**但 bound/grace 的旧会话（手机在线/宽限中）除外**（2026-09-24 修订：二维码区常驻后，连接中重签/切换自动刷新不得打断在线会话；旧会话自然结束后票据失效，新设备扫新码仍经 bindPhoneStream 踢旧）。**不向桌面回发 `session_invalid(superseded)`**——替换由桌面发起，`session_issued` 即回执；先回发 invalid 会与 in-flight 的 issued 竞态（invalid 先到、桌面 `currentSid` 未推进）触发无限重签（2026-09-24 修复）。桌面侧对 `reason="superseded"` 一律忽略（防旧版 relay）。
5. **自动刷新**（桌面侧行为，relay 无感知）：弹窗开关「开启自动刷新」：
   - 开（默认短时模式之外的新默认为关）：按 `persistent=false` 出票，到期自动重签（原 §7.1 逻辑），切换动作立即重签一次；
   - 关（默认）：按 `persistent=true` 出票，无到期重签；仅手动刷新/断开重连场景重签。
   - 开关为 UI 偏好（renderer localStorage 持久化，key `zcode:remote-control:auto-refresh`），经 IPC `RemoteControlSetAutoRefresh` 同步给 Main。
6. `pending` 状态（`DesktopRemoteControlState`）扩展为 `{ sid; url; expiresAt: number | null; autoRefresh: boolean }`。

### 21.2 断开连接 ≠ 关闭功能（修订 §7 UI 语义）

1. 新增控制帧（C→S）`{ v:1; type:"disconnect_session"; sid }`：relay 执行 `disconnectSession(sid)`——手机 WS close `4006 desktop-disconnected`、桌面收 `stream_close(phone_stop)`、`activeStream/boundSid` 释放、**会话回退 `pending` 且 sessionToken 清空**（票据仍有效，手机可凭原链接重新 bind）。
2. 桌面 `disconnect()` 语义：仅断开当前设备，功能保持开启，UI 回 `pending`（沿用当前票据）；新增 IPC `RemoteControlDisconnect`。
3. 「关闭手机远控」仍是 `stop()`（revoke 票据 + 拆连接 + disabled），入口独立于断开连接。
4. 手机侧收到 4006：不自动重连，展示「已在电脑端断开连接」+「重新连接」按钮（重新 bind 同一 URL）。

### 21.3 桌面 UI 批量修订

1. **入口图标状态色**（侧栏底部手机图标）：`connected` 绿（emerald）、`pending/waiting` 橙（amber）、`disabled`/未启用 默认色。
2. **复制链接**：pending 态提供「复制链接」按钮（clipboard 写入票据 URL，成功后短暂反馈）。
3. **弹窗按钮**：pending = 刷新/复制 + 自动刷新开关；connected = 「断开连接」（disconnect）+「关闭远控」（stop）；waiting = 刷新 + 关闭远控。

### 21.4 手机页 UX 批量修订

1. **连接进度**：连接阶段展示步骤化进度（校验票据 → 建立中转连接 → 等待桌面挂载 → 同步工作区 → 完成），当前步高亮/spinner，失败步标红并给出原因。
2. **连接信息**：主界面常驻连接徽标（中继/直连）；点开面板展示：连接模式、实时延迟（周期性轻量 RPC RTT）、连接时长、接入点域名。
3. **小屏导航**：视口 < 768px 且非桌面壳时，侧栏改为覆盖式抽屉（选会话即收起），对话区提供「返回会话列表」入口；禁用原 resize 自动收缩逻辑（其在手机上必命中且无唤出入口）。Web 小屏同享此行为。

### 21.5 远程会话能力门控

1. 手机远控渲染的 Root 标记 `isRemoteSession=true`：任务列表/分组视图/Header 的「在 Finder 中打开」类菜单项隐藏（接线既有 `hideMobileUnsupportedActions`/`simplifyForNarrowRemote`），文件树/Git 面板沿用 `isDesktop` 门控。
2. 「添加项目」入口：`allowOpenWorkspace=false` 且无远程工作区入口时整体隐藏（不再静默无反应）。
3. 设置页依赖 `platform.selectDirectory` 的「浏览」按钮：`canSelectFilePath` 为 false 时禁用并提示（Web 主站同享）。

### 21.6 P2P 会话被顶替的踢人闭环（2026-09-24）

被踢设备若已升级 P2P（中转管道已按 4005 退役），relay 的 `close_phone(4001)` 触达不了它——旧设备会停留在「页面还在、操作全无响应」的假死状态。闭环契约（三方配合）：

1. **relay**：会话记录 `closedByKick`（跨 sid 踢人/单活票据替换置位）与 `supersededTokens`（同 sid 重铸 token 时登记旧 token，上限 4 个）；`checkPhoneUpgrade` 对「被顶替设备凭旧 token 重连」返回 **4001**（reason `superseded`）而非 4004。`disconnectSession` 回退 pending 时两者清空。
2. **桌面**：收到 `stream_close(reason="kicked", sid=当前票据 sid)` 且无活跃中转流、RTC 仍存活时，调用 `rtcDelegate.disposeP2p()` 拆除 DataChannel（旧手机 `dc.onclose` → 按 §9.4 回退中转重连），随后进入 waiting（新设备 stream_open 到达即 connected）。
3. **手机**：回退重连的 WS 升级被拒收 4001 → 展示「当前会话已在其他地方登录」+「重新连接」（长效票据可反抢，属多设备转移语义）；onClose 判定的终态（4001/4004/4006）优先于 catch 分支的重新 bind，不得被覆盖。

### 21.7 P2P 可达性与观测（2026-09-24）

真机 11/11 协商失败均为 `signal-budget-exceeded`。经浏览器真机复现 + 分层观测定位出**三处真实缺陷并全部修复**（单测均用内存假窗口，从未覆盖真实链路）：

1. **命令投递竞态**：控制器在窗口 `loadURL → executeJavaScript(胶水)` 完成前即发送 `negotiate`，而 preload 的命令订阅按需注册（P1-2），消息到达时无监听被静默丢弃。修复：Main 侧在收到胶水 `glue-ready` console 信号前缓冲命令（`rtcWindow.ts`），就绪后 flush。
2. **iceServers 格式错误**：胶水把字符串数组直接传给 `new RTCPeerConnection({iceServers})` → TypeError 在 message 监听器内被吞（手机侧是正确的 `[{urls}]`）。修复：map 成 `{urls}` 对象。
3. **发起方通道未桥接**：`createDataChannel` 返回值被丢弃，`ondatachannel` 只在应答方触发 → 桌面（发起方）dc-open 永不出现。修复：创建后立即 `bridgeDataChannel`。
4. **模板转义教训**：胶水脚本是 TS 模板字面量，内嵌字符串不得使用 `\n` 等转义（求值后变成真实换行 → 注入 SyntaxError）；需要换行拆分用 `String.fromCharCode(10)`。
5. **STUN 多服务器化**：relay `DEFAULT_STUN_URLS` 与桌面 wiring 缺省统一为 `miwifi → qq → google` 三服务器；部署侧 `RELAY_STUN_URLS` / 桌面 `stunUrls` 覆盖。
6. **观测面（常驻）**：胶水以 `[rtc-glue]` 前缀输出 negotiate/offer/answer/ice 状态/dc 事件，Main 经 console-message 转发（error 级一并转发）；注入链路逐步落日志 + 失败自动重试一次；控制器记录 offer-sent/answer-received；relay 记录 signal connected/closed 与 rtc_signal 丢弃原因。
7. **relay 重启后的长效票据**：relay 无盘重启使长效票据作废且无法回发 invalid → 桌面在 relay 断开后统一置 `needTicket`，重连注册后重签（§10 断线矩阵语义补齐）。

修复后真机验证：glue → negotiate → offer → answer（~0.6s）→ ICE connected → dc-open → p2p attachment 绑定 → 手机徽标「直连」。

**已知遗留（已修复，2026-09-24 第二轮）**：dc 建立后 ~30ms 被关闭——死亡现场快照（`dc-closed pc=connected ice=connected sent=2`，末条出站 387KB）定位为**大消息打死 DataChannel**：Host 下发的工作区快照（数百 KB）超过 SCTP 单消息协商上限。修复：两侧桥接（桌面窗口胶水 + 手机 dataChannelAsPort）实现对称**分片传输**（≤60KB/片；帧格式 0x00 裸小消息 / 0x01 u32be总长+u32be偏移+载荷，接收侧按总长重组），dc.send 全部 try/catch。

### 21.9 重试上限与降级（2026-09-24）

1. **P2P 硬上限 = 5**：桌面控制器累计失败（跨冷却窗口）达 5 次后，本服务生命周期内对所有 `p2p_request` 回 `reject(p2p-disabled)`（stop/dispose 重置；成功 dc-open 重置）；手机端同样计数 5 次（成功清零，达限后本页面生命周期不再发起协商）。双端同限互为保险。
2. **中继失败上限 = 5**：手机端每次连接尝试失败（WS 升级失败/网络不可达）计数 +1，到达 connected 清零；连续 5 次失败进入 **failed 终态**——展示「连接失败」卡片与「重试」按钮（手动重试清零计数），不再自动重连。
3. 控制器时钟可注入（`now` dep），用于跨冷却窗口的上限测试。

### 21.10 P2P 会话丢失与窗口生命周期（2026-09-24）

1. **dc 断开 → service 转 waiting**：此前 dc-closed 只翻传输徽标，手机页面关闭后 UI 永远停留在「已连接」。现在控制器 dc 断开/失败且 P2P 曾上线时回调 `onP2pLost`，service `noteP2pLost()` 转 waiting（设备卡片与票据快照保留，grace 到期自动重签）。
2. **RTC 窗口被用户手动关闭**：BrowserWindow `closed` 事件合成 `dc-closed` 上抛（仅用户关闭路径；控制器正常 teardown 已置 destroyed 不重复上抛），同路径拆 attachment + 通知 waiting——否则残留 p2pActive 永久 busy 拒绝后续协商（真机：关窗后回不到直连）。
   2a. **P2P 下桌面主动断开的完整闭环（2026-09-24 第二轮）**：此前的三处缺口——① `disconnect()` 不拆 P2P（activeStream 已清空，teardownAttachment 拆不到），被"断开"的手机仍可经直连操作；② relay `disconnectSession` 对无活跃中转流的 P2P 会话不发 `stream_close(phone_stop)`；③ 手机侧只能等 ICE consent 超时（10-40s）才感知。修复：桌面 `disconnect()` 调 `disposeP2p("desktop-disconnected")`；relay 用会话保留的旧 streamId 补发 `stream_close(phone_stop)` 且将旧 token 登记 `disconnectedTokens`（凭其回连收 4006 而非 4004）；新增 **0x02 应用层控制帧**（分片帧格式扩展：`0x02 + JSON{type:"remote-disconnect", reason}`）——控制器 `disposeWithNotify(reason)` 先发通知再延迟 250ms 硬拆，手机 `onRemoteDisconnected` 秒级进入终态屏（desktop-disconnected→「已在电脑端断开连接」/superseded→「当前会话已在其他地方登录」），并在途回退重连一并终止。被顶替路径同样受益（无需等回退重连拿 4001）。
3. **窗口隐藏加固**：`setHiddenInMissionControl` 在 ready-to-show 后补调一次（API 要求窗口 ready 后调用才稳定生效）。

### 21.8 弹窗常驻二维码与设备卡片（2026-09-24）

1. waiting/connected 态携带 `ticket`（当前活票据快照）与 `deviceUa`（waiting 最近在线设备）；连接期间重签只更新票据快照、不打断状态相位。
2. 弹窗所有活跃相位常驻展示：二维码 + 时效胶囊（长期有效/倒计时）+ 自动刷新开关 + 刷新二维码 + 复制链接；「关闭远程控制」为底部弱化按钮。
3. 设备卡片：UA 推断形态图标（Android/iOS/Mac/Windows/Linux）+ 状态胶囊（连接=绿/重连=琥珀+倒计时）+ **类型化文案**（「{设备类型}已连接 / {设备类型}可以控制当前工作区」，解析失败回落「移动设备」）+ **UA 摘要独立一行**（`deviceUa.ts` 纯函数解析「浏览器 版本 · 系统 版本」，自动截断；行尾 info 图标 hover 展示完整 UA）；右侧断开图标按钮仅连接态显示。
4. 更名「手机远控」→「移动端远程控制」（i18n 全量更新，文案对齐 2026-09-24 设计稿）。

### 21.9 远控弹窗合并 Bot 渠道与动作防抖（2026-09-25）

1. **单一入口**：侧栏 footer 只保留一个 Smartphone 图标（状态色规则不变），上游 v3.14.3 合入的 Bot 渠道远控入口不再单独展示图标——三图标并排会挤压用户信息组件，且 Bot 入口依赖 `workspacePath`，在设置页会消失。
2. **弹窗布局**：「移动端远程控制」弹窗改为左右分栏（`sm:max-w-2xl`，左窄右宽 `1.15fr/1fr`）：左栏=手机扫码直连（§21.8 的二维码/设备卡片/票据/操作行，逻辑全部走二开 relay 实现，不引入上游手机页实现）；右栏=Bot Channel 渠道列表（微信/飞书/Lark/Telegram + 机器人管理，点击打开 `BotsDialog`，复用上游 `webRemoteControl.botChannel.*` 文案）。无 `workspacePath`（设置页）时右栏整体禁用并提示需先打开工作区。
3. **动作 pending 态与防抖**（owner：`useRemoteControl` renderer hook，Main 状态机不变）：`start/stop/disconnect/refreshTicket` 执行期间暴露 `pendingAction`（同一时间至多一个）；pending 中重复调用同一动作直接忽略（防抖），对应按钮展示 spinner 并禁用（loading 反馈）。解除条件：IPC promise 落定，或状态推送到达目标相位（start→非 disabled / stop→disabled），先到先清，防止 IPC 丢失导致永久卡 pending。
4. **i18n**：`remoteControl.description` 更新为覆盖两种远控方式的文案；新增 `webRemoteControl.botChannel.noWorkspace`（无工作区提示）。`WorkspaceWebRemoteControlTrigger`/`WebRemoteControlDialog` 组件随合并删除，文案键保留由 `BotChannelSection` 消费。

### 21.10 配置文件自检、顶层开关与入口解耦（2026-09-25）

1. **启动自检（幂等）**：App 启动时（wiring 创建）检查 `~/.mikiko/remote-control.json`——不存在则写入默认值 `{ enabled: true, relayWsUrl: "wss://ws.mikiko.ai/ws/desktop", relayHttpUrl: "https://ws.mikiko.ai" }`（§19 生产端点）；存在（含用户自定义）则不操作；写入失败仅告警不阻断启动。逻辑在 `remoteControl/fileConfig.ts`（无 electron 依赖，node:test 直测 `test/remoteControl/fileConfig.test.ts`）。
2. **顶层 `enabled` 开关**：仅显式 `false` 视为停用（历史配置无此字段按启用，不改写用户文件）。停用时：`getState` 恒报 `{phase:"disabled", disabledReason:"config"}`、`start` 不生效、不接 RTC 与版本门控；**手机扫码直连**整体停用，Bot 渠道不受影响。
3. **入口解耦**：`RemoteControlGetState` 的 `enabled` 只反映平台能力（桌面恒注册 IPC → true；Web 无方法 → 入口隐藏），不再受配置文件影响。relay 端点完全不可解析（service=null，零出网）时入口仍展示，`state.disabledReason="unconfigured"` 适配。
4. **UI 适配**：`disabledReason` 存在时左栏不展示「开启移动端远程控制」按钮，改用 `PowerOff` 停用图标 + 归因文案（`remoteControl.disabled.configDisabled` / `remoteControl.disabled.unconfigured`，含改回方法）。
5. **弹窗尺寸**：`sm:max-w-3xl` + `grid-cols-2` + `items-stretch`——右栏 Bot 描述单行不换行；左右分栏边框高度统一，左栏内容（含二维码与 disabled 空态）垂直居中。

终验（2026-09-24）：`remote.mikiko.ai` 静态 200（主 JS 2.4MB/s）+ `wss://ws.mikiko.ai` 数据面全通；票据 URL 生成于 `https://remote.mikiko.ai`；手机端落地页→连接→主界面真实数据渲染通过；quick tunnel 已退役，服务器仅存 `mikiko-relay`/`mikiko-tunnel` 两个 systemd 服务。

## 22. 版本兼容与自动部署（2026-09-24）

1. **relay 前向宽容**（`parseRemoteControlDesktopFrameTolerant`/`parseRemoteControlRtcSignalTolerant`）：剥除未知字段后再 strict 校验——新桌面/新手机 + 旧 relay 不再整帧判非法断连（曾致硬故障）。桌面客户端自用解析保持 strict。
2. **healthz 版本报告**：`{ok, version, protocolVersion, minDesktopAppVersion, minPageVersion}`（字段只增不改）。桌面 start 前门控（wiring `gateRelayCompatibility`）：低于 minDesktopAppVersion → 禁用并展示「当前版本不支持远程控制服务…请升级应用」；探测失败（网络）放行走既有重连语义。
3. **手机页版本提示**：bind 响应附 `relayCapabilities.minPageVersion`（旧手机端按 unknown 容忍）；页面低于要求 → 「远控服务已更新」+ 刷新按钮（Pages 常新，刷新即升级）。页面协议版本常量 `REMOTE_PAGE_VERSION`。
4. **部署顺序约定**：relay 先升（宽容解析保证兼容）→ 桌面 → Pages 手机页。
5. **自动部署**：`.github/workflows/deploy-remote-control.yml`——push main 触发 relay→VPS(SSH secret RELAY_DEPLOY_KEY)、手机页→Pages(secret CLOUDFLARE_API_TOKEN)、update Worker 部署；secrets 未配置时对应 job 跳过。
