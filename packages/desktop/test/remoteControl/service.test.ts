import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeRemoteControlDataFrame,
  type RemoteControlDesktopFrame,
} from "@zcode/shared/remote-control";
import {
  createRemoteControlService,
  type RemoteControlServiceTimers,
} from "../../src/main/remoteControl/service.js";
import type {
  RelayTransport,
  RelayTransportHandlers,
} from "../../src/main/remoteControl/relayConnection.js";
import type { PumpPort } from "../../src/main/remoteControl/streamPump.js";

/**
 * remoteControlService 状态机单测：假传输 + 手动时钟 + 假 attachment，
 * 按 spec §7.1 事件顺序逐项验证。真实 RelayConnection/泵都参与（仅传输层假）。
 */

class FakeTimers implements RemoteControlServiceTimers {
  private nowMs = 10_000_000;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(handler: () => void, ms: number): unknown {
    this.seq += 1;
    const id = this.seq;
    this.tasks.set(id, { at: this.nowMs + ms, fn: handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (handle != null) {
      this.tasks.delete(handle as number);
    }
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (const [id, task] of Array.from(this.tasks)) {
      if (task.at <= this.nowMs) {
        this.tasks.delete(id);
        task.fn();
      }
    }
  }
}

class FakePort implements PumpPort {
  hostReceived: unknown[] = [];
  private messageListener: ((event: { data: unknown }) => void) | null = null;
  private closeListener: (() => void) | null = null;
  closed = false;

  on(event: "message" | "close", listener: never) {
    if (event === "message") {
      this.messageListener = listener as (event: { data: unknown }) => void;
    } else {
      this.closeListener = listener as () => void;
    }
    return undefined;
  }

  /** 泵投递：发往 Host 侧。 */
  postMessage(message: unknown): void {
    queueMicrotask(() => this.hostReceived.push(message));
  }

  start(): void {}

  close(): void {
    this.closed = true;
    this.closeListener?.();
  }

  /** 测试注入：Host 侧发出的消息（泵经 on("message") 收到）。 */
  emitFromHost(data: unknown): void {
    queueMicrotask(() => this.messageListener?.({ data }));
  }
}

function createHarness() {
  const timers = new FakeTimers();
  const transports: {
    url: string;
    handlers: RelayTransportHandlers;
    sentFrames: RemoteControlDesktopFrame[];
    sentBinary: { streamId: number; payload: Uint8Array }[];
    closed: boolean;
  }[] = [];
  const attachCalls: number[] = [];
  const detachCalls: Array<{ webContentsId: number; attachmentId: string; reason: string }> = [];
  const states: Array<ReturnType<typeof service0>> = [];
  const clearCredentialCalls: number[] = [];
  let portSeq = 0;
  const ports = new Map<number, FakePort>();

  function service0() {
    return null as never;
  }
  void service0;

  const service = createRemoteControlService({
    relayWsUrl: "ws://relay.test/ws/desktop",
    transportFactory: (url, handlers) => {
      const record = {
        url,
        handlers,
        sentFrames: [] as RemoteControlDesktopFrame[],
        sentBinary: [] as { streamId: number; payload: Uint8Array }[],
        closed: false,
      };
      transports.push(record);
      const transport: RelayTransport = {
        sendText: (text) => record.sentFrames.push(JSON.parse(text) as RemoteControlDesktopFrame),
        sendBinary: (data) => {
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          record.sentBinary.push({ streamId: view.getUint32(0, false), payload: data.subarray(4) });
        },
        close: () => {
          record.closed = true;
        },
      };
      return transport;
    },
    device: {
      ensureCredentials: async () => ({ mid: "mid-1", token: "token-1" }),
      clearCredentials: async () => {
        clearCredentialCalls.push(1);
      },
      deviceName: "测试机",
      appVersion: "3.14.0",
    },
    attachPort: (webContentsId) => {
      attachCalls.push(webContentsId);
      portSeq += 1;
      const port = new FakePort();
      ports.set(portSeq, port);
      return { attachmentId: `attach-${portSeq}`, port };
    },
    detachPort: (webContentsId, attachmentId, reason) => {
      detachCalls.push({ webContentsId, attachmentId, reason });
    },
    activeWebContentsId: () => 7,
    broadcastState: (state) => states.push(state),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    timers,
  });

  const current = () => transports[transports.length - 1];

  function emitFrame(frame: RemoteControlDesktopFrame): void {
    current().handlers.onText(JSON.stringify(frame));
  }

  return {
    timers,
    service,
    transports,
    current,
    emitFrame,
    attachCalls,
    detachCalls,
    states: states as unknown as Array<{ phase: string }>,
    clearCredentialCalls,
    port(portId: number): FakePort {
      return ports.get(portId)!;
    },
  };
}

const V = 1;

test("启动链路：register → issue → pending → stream_open → connected", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0)); // ensureCredentials 异步。

  const transport = h.current();
  assert.match(transport.url, /ws:\/\/relay\.test\/ws\/desktop\?mid=mid-1&token=token-1/);
  assert.deepEqual(
    transport.sentFrames.map((frame) => frame.type),
    ["register"],
  );

  h.emitFrame({ v: V, type: "register_ok" });
  assert.deepEqual(
    transport.sentFrames.map((frame) => frame.type),
    ["register", "issue_session"],
    "register_ok 后才签发票据",
  );
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "https://m.test/remote?sid=s_1",
    expiresAt: h.timers.now() + 600_000,
  });
  assert.equal(h.service.getState().phase, "pending");

  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "test-phone", p2pCapable: true },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");
  assert.deepEqual(h.attachCalls, [7]);
  assert.ok(
    h
      .current()
      .sentFrames.some((frame) => frame.type === "stream_accepted" && frame.streamId === 0),
  );
});

test("数据通路：手机帧 → Host；Host 消息 → 手机（经真实泵翻译）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: h.timers.now() + 600_000,
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 3,
    sid: "s_1",
    phone: { ua: "p", p2pCapable: false },
    transport: "relay",
  });

  // 手机 → Host：手工构造 13B Regular 帧，经 RelayConnection 解码进泵。
  const payload = new TextEncoder().encode("rpc-from-phone");
  const framed = new Uint8Array(13 + payload.byteLength);
  framed[0] = 1; // Regular
  new DataView(framed.buffer).setUint32(9, payload.byteLength, false);
  framed.set(payload, 13);
  h.current().handlers.onBinary(encodeRemoteControlDataFrame(3, framed));
  const port = h.port(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(port.hostReceived.length, 1);
  assert.ok(port.hostReceived[0] instanceof Uint8Array);
  assert.deepEqual(port.hostReceived[0], payload);

  // Host → 手机：postMessage ArrayBuffer → 泵补帧头 → connection 加 streamId 前缀。
  port.emitFromHost(new TextEncoder().encode("rpc-to-phone").buffer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.current().sentBinary.length, 1);
  const sent = h.current().sentBinary[0]!;
  assert.equal(sent.streamId, 3);
  assert.deepEqual(sent.payload.subarray(13), new TextEncoder().encode("rpc-to-phone"));
});

test("手机断开：stream_close(lost) → waiting → 5min 超时重签", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: h.timers.now() + 600_000,
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "", p2pCapable: false },
    transport: "relay",
  });

  h.emitFrame({ v: V, type: "stream_close", streamId: 0, sid: "s_1", reason: "lost" });
  assert.equal(h.service.getState().phase, "waiting");
  assert.equal(h.detachCalls.length, 1);

  // grace 内手机重连（relay 复用旧 sid）。
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 1,
    sid: "s_1",
    phone: { ua: "", p2pCapable: false },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");

  // 再断开并超时 → 重签票据。
  h.emitFrame({ v: V, type: "stream_close", streamId: 1, sid: "s_1", reason: "lost" });
  h.timers.advance(5 * 60_000 + 1);
  assert.ok(
    h.current().sentFrames.some((frame) => frame.type === "issue_session"),
    "waiting 超时后重新签发票据",
  );
});

test("踢人双保险：第二个 stream_open 先拆旧再挂新", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: h.timers.now() + 600_000,
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "A", p2pCapable: false },
    transport: "relay",
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 5,
    sid: "s_2",
    phone: { ua: "B", p2pCapable: false },
    transport: "relay",
  });

  assert.equal(h.service.getState().phase, "connected");
  assert.deepEqual(h.attachCalls, [7, 7], "两次 attach");
  assert.equal(h.detachCalls.length, 1, "旧 attachment 先拆");
  assert.equal(h.detachCalls[0]?.attachmentId, "attach-1");
  assert.ok(h.port(1).closed, "旧泵已 dispose");
});

test("relay 断开：attachment 拆除 → waiting → 退避重连（pending 不重签）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: h.timers.now() + 600_000,
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "", p2pCapable: false },
    transport: "relay",
  });

  h.current().handlers.onClose(1006, "abnormal");
  assert.equal(h.service.getState().phase, "waiting");
  assert.equal(h.detachCalls.length, 1);

  // 退避 1s 后重连（ensureCredentials 异步，需 flush microtask）。
  h.timers.advance(1000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.transports.length, 2, "重连创建新传输");
  h.emitFrame({ v: V, type: "register_ok" });
  // waiting 未超 grace：不重签，等手机凭旧 sid 重连。
  assert.ok(
    !h.current().sentFrames.some((frame) => frame.type === "issue_session"),
    "waiting 未超时不重签",
  );
  // 手机重连成功。
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "", p2pCapable: false },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");
});

test("从未注册成功即断开：首轮不清凭证（容忍网络瞬断），连续两轮才清（relay 重启语义）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 首轮未注册即断开：普通网络瞬断不清凭证。
  h.current().handlers.onClose(1006, "closed before register");
  assert.equal(h.clearCredentialCalls.length, 0, "首轮不清 deviceToken");
  h.timers.advance(1000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.transports.length, 2, "首轮仍按退避重连");

  // 第二轮仍未注册成功：判定 relay 重启/token 失效，清除后走重新注册。
  h.current().handlers.onClose(1006, "closed before register again");
  assert.equal(h.clearCredentialCalls.length, 1, "连续两轮清除 deviceToken");
  h.timers.advance(2000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.transports.length, 3);
});

test("stop：revoke + detach + disabled；票据到期自动重签", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  const expiresAt = h.timers.now() + 600_000;
  h.emitFrame({ v: V, type: "session_issued", sid: "s_1", url: "u", expiresAt });

  // 票据超时 → 自动重签。
  h.timers.advance(600_000 + 3000);
  const issues = h.current().sentFrames.filter((frame) => frame.type === "issue_session");
  assert.equal(issues.length, 2, "到期后自动 issue");

  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "", p2pCapable: false },
    transport: "relay",
  });
  const stopped = h.service.stop();
  assert.equal(stopped.phase, "disabled");
  assert.ok(h.current().sentFrames.some((frame) => frame.type === "revoke_session"));
  assert.equal(h.detachCalls.length, 1);
  assert.equal(h.service.getState().phase, "disabled");
});

test("session_invalid(superseded) 不触发重签：单活票据替换由桌面发起，issued 即回执（spec §21.1.4）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: null,
  });
  const issuesBefore = h.current().sentFrames.filter((frame) => frame.type === "issue_session");

  // 即使 sid 匹配当前票据，superseded（旧 relay 对桌面自发替换的回执）也必须忽略，
  // 否则与 in-flight 的 session_issued 竞态会造成无限换码。
  h.emitFrame({ v: V, type: "session_invalid", sid: "s_1", reason: "superseded" });
  const issuesAfter = h.current().sentFrames.filter((frame) => frame.type === "issue_session");
  assert.equal(issuesAfter.length, issuesBefore.length, "superseded 不引起重签");

  // 非 superseded（如 expired）仍按原语义重签。
  h.emitFrame({ v: V, type: "session_invalid", sid: "s_1", reason: "expired" });
  assert.equal(
    h.current().sentFrames.filter((frame) => frame.type === "issue_session").length,
    issuesBefore.length + 1,
    "expired 仍触发重签",
  );
});

test("P2P 被顶替：stream_close(kicked, 当前sid) 拆 RTC 并回 waiting（spec §21.6）", async () => {
  const h = createHarness();
  let p2pActive = true;
  let disposed = 0;
  h.service.setRtcDelegate({
    isP2pActive: () => p2pActive,
    disposeP2p: () => {
      disposed += 1;
      p2pActive = false;
    },
  });
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: null,
  });
  // 模拟 P2P 升级后的状态：无活跃中转流（stream_close(p2p_promoted) 已拆）。
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "A", p2pCapable: true },
    transport: "relay",
  });
  h.emitFrame({ v: V, type: "stream_close", streamId: 0, sid: "s_1", reason: "p2p_promoted" });
  assert.equal(h.service.getState().phase, "connected", "升级后保持 connected");

  // 新设备顶替：relay 对旧流发 stream_close(kicked)，旧 streamId 不在 activeStream。
  h.emitFrame({ v: V, type: "stream_close", streamId: 0, sid: "s_1", reason: "kicked" });
  assert.equal(disposed, 1, "RTC 被拆除");
  assert.equal(h.service.getState().phase, "waiting");

  // 新设备 stream_open 到达即 connected。
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 1,
    sid: "s_1",
    phone: { ua: "B", p2pCapable: false },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");

  // 跨票据顶替（sid 不同）同样拆除：残留 RTC 会阻塞后续协商（spec §21.9）。
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 2,
    sid: "s_2",
    phone: { ua: "C", p2pCapable: true },
    transport: "relay",
  });
  p2pActive = true; // C 升级 P2P（当前票据已是 s_2 之外的旧值，验证不依赖 sid 匹配）。
  h.emitFrame({ v: V, type: "stream_close", streamId: 2, sid: "s_2", reason: "p2p_promoted" });
  disposed = 0;
  h.emitFrame({ v: V, type: "stream_close", streamId: 2, sid: "s_2", reason: "kicked" });
  assert.equal(disposed, 1, "跨 sid 顶替也拆 RTC");
  p2pActive = false;

  // 非 P2P 场景的迟到 kicked（无 RTC）不得误触发。
  disposed = 0;
  p2pActive = false;
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 3,
    sid: "s_2",
    phone: { ua: "D", p2pCapable: false },
    transport: "relay",
  });
  h.emitFrame({ v: V, type: "stream_close", streamId: 99, sid: "s_2", reason: "kicked" });
  assert.equal(disposed, 0);
  assert.equal(h.service.getState().phase, "connected", "无关事件不改变状态");
});

test("noteP2pLost：P2P 断开后转 waiting（设备卡片保留，spec §21.10）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({ v: V, type: "session_issued", sid: "s_1", url: "u", expiresAt: null });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "phone-a", p2pCapable: true },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");
  h.service.noteP2pLost();
  const state = h.service.getState();
  assert.equal(state.phase, "waiting");
  if (state.phase === "waiting") {
    assert.equal(state.deviceUa, "phone-a", "设备卡片信息保留");
    assert.ok(state.ticket, "票据快照保留，二维码常驻");
  }
});

test("disconnect：P2P 活跃时直接拆除 RTC，手机不再可操作（spec §21.2）", async () => {
  const h = createHarness();
  let p2pActive = false;
  let disposed = 0;
  h.service.setRtcDelegate({
    isP2pActive: () => p2pActive,
    disposeP2p: () => {
      disposed += 1;
      p2pActive = false;
    },
  });
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "https://m.test/remote?sid=s_1",
    expiresAt: null,
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "phone-a", p2pCapable: true },
    transport: "relay",
  });
  // 模拟 P2P 升级：无活跃中转流（stream_close(p2p_promoted) 已拆）。
  p2pActive = true;
  h.emitFrame({ v: V, type: "stream_close", streamId: 0, sid: "s_1", reason: "p2p_promoted" });
  assert.equal(h.service.getState().phase, "connected");

  const state = h.service.disconnect();
  assert.equal(disposed, 1, "P2P 活跃时断开必须拆除 RTC");
  assert.equal(state.phase, "pending");
  assert.ok(
    h.current().sentFrames.some((frame) => frame.type === "disconnect_session"),
    "仍向 relay 发送 disconnect_session",
  );

  // relay 补发的回执（无活跃中转流）：幂等收敛到 pending，不误进 waiting。
  h.emitFrame({ v: V, type: "stream_close", streamId: 0, sid: "s_1", reason: "phone_stop" });
  assert.equal(h.service.getState().phase, "pending");
});

test("disconnect：仅踢当前设备，回 pending 展示同一票据（spec §21.2）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "https://m.test/remote?sid=s_1",
    expiresAt: null,
  });
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 0,
    sid: "s_1",
    phone: { ua: "phone-a", p2pCapable: false },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");

  const state = h.service.disconnect();
  assert.equal(state.phase, "pending");
  if (state.phase === "pending") {
    assert.equal(state.url, "https://m.test/remote?sid=s_1", "沿用当前票据");
    assert.equal(state.expiresAt, null);
  }
  assert.ok(
    h.current().sentFrames.some((frame) => frame.type === "disconnect_session"),
    "向 relay 发送 disconnect_session",
  );
  assert.equal(h.detachCalls.length, 1, "attachment 已拆");
  assert.equal(h.transports.length, 1, "relay 长连保持（功能未关闭）");

  // relay 回执 stream_close(phone_stop)：保持 pending，不进 waiting。
  h.emitFrame({ v: V, type: "stream_close", streamId: 0, sid: "s_1", reason: "phone_stop" });
  assert.equal(h.service.getState().phase, "pending");

  // 手机凭同一票据重连：stream_open → connected。
  h.emitFrame({
    v: V,
    type: "stream_open",
    streamId: 1,
    sid: "s_1",
    phone: { ua: "phone-a", p2pCapable: false },
    transport: "relay",
  });
  assert.equal(h.service.getState().phase, "connected");
});

test("autoRefresh：切换即重签；长效票据无到期重签（spec §21.1）", async () => {
  const h = createHarness();
  h.service.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.emitFrame({ v: V, type: "register_ok" });
  // 默认 autoRefresh=false：issue_session 携带 persistent:true。
  const firstIssue = () =>
    h
      .current()
      .sentFrames.filter((frame) => frame.type === "issue_session")
      .at(-1);
  assert.equal(firstIssue()?.persistent, true);
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_1",
    url: "u",
    expiresAt: null,
  });
  const pending = h.service.getState();
  assert.equal(pending.phase, "pending");
  if (pending.phase === "pending") {
    assert.equal(pending.autoRefresh, false);
    assert.equal(pending.expiresAt, null);
  }

  // 长效票据：大幅推进时钟不自动重签。
  h.timers.advance(24 * 60 * 60_000);
  assert.equal(
    h.current().sentFrames.filter((frame) => frame.type === "issue_session").length,
    1,
    "长效票据无到期重签",
  );

  // 开启自动刷新：立即重签且 persistent 不再携带。
  h.service.setAutoRefresh(true);
  assert.equal(firstIssue()?.persistent, undefined, "短时票据不携带 persistent");
  h.emitFrame({
    v: V,
    type: "session_issued",
    sid: "s_2",
    url: "u2",
    expiresAt: h.timers.now() + 600_000,
  });
  const shortPending = h.service.getState();
  if (shortPending.phase === "pending") {
    assert.equal(shortPending.autoRefresh, true);
  }
  // 短时票据到期 → 自动重签（仍为短时）。
  h.timers.advance(600_000 + 3000);
  assert.equal(firstIssue()?.persistent, undefined, "自动重签保持短时票据");
});
