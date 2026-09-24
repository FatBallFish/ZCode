import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import {
  REMOTE_CONTROL_WS_CLOSE,
  decodeRemoteControlDataFrame,
  encodeRemoteControlDataFrame,
  type RemoteControlDesktopFrame,
} from "@zcode/shared/remote-control";
import { startRelayServer, type RelayServerHandle } from "../src/server.js";

/**
 * relay 端到端测试：真实 HTTP + WS + 状态机。
 * 每个用例独立启动一个 relay 实例（限频器与会话状态互不污染），
 * 桌面/手机均用真实 ws 客户端，按 spec §10 断线矩阵逐场景验证。
 */

const SECRET = "e2e-secret";
const MID = "mid-e2e";

interface RelayContext {
  handle: RelayServerHandle;
  baseUrl: string;
  wsBase: string;
  deviceToken: string;
}

async function withRelay(run: (ctx: RelayContext) => Promise<void>): Promise<void> {
  const handle = await startRelayServer({
    secret: SECRET,
    webRemoteBase: "https://m.example.com/remote",
    publicWsBase: "ws://127.0.0.1:0",
    stunUrls: ["stun:stun.example.com:3478"],
  });
  const baseUrl = `http://127.0.0.1:${handle.port}`;
  const registerResponse = await fetch(`${baseUrl}/api/rc/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mid: MID, name: "测试 Mac", appVersion: "3.14.0-test" }),
  });
  assert.equal(registerResponse.status, 200);
  const deviceToken = ((await registerResponse.json()) as { deviceToken: string }).deviceToken;
  try {
    await run({ handle, baseUrl, wsBase: `ws://127.0.0.1:${handle.port}`, deviceToken });
  } finally {
    await handle.close();
  }
}

class ControlCollector {
  readonly frames: RemoteControlDesktopFrame[] = [];
  private waiters: Array<{
    test: (frame: RemoteControlDesktopFrame) => boolean;
    resolve: (frame: RemoteControlDesktopFrame) => void;
  }> = [];

  push(frame: RemoteControlDesktopFrame): void {
    const waiter = this.waiters.find((entry) => entry.test(frame));
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  async expect(
    test: (frame: RemoteControlDesktopFrame) => boolean,
    timeoutMs = 5000,
  ): Promise<RemoteControlDesktopFrame> {
    const buffered = this.frames.find(test);
    if (buffered) {
      this.frames.splice(this.frames.indexOf(buffered), 1);
      return buffered;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待控制帧超时")), timeoutMs);
      this.waiters.push({
        test: (frame) => {
          const hit = test(frame);
          if (hit) {
            clearTimeout(timer);
          }
          return hit;
        },
        resolve,
      });
    });
  }
}

function connectDesktop(ctx: RelayContext, collector: ControlCollector): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ctx.wsBase}/ws/desktop?mid=${MID}&token=${ctx.deviceToken}`);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        collector.push(JSON.parse(data.toString("utf8")) as RemoteControlDesktopFrame);
      }
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

interface PhoneTicket {
  sid: string;
  sessionToken: string;
  /** 原始票据 bind 参数（多次 bind/断开后重连场景复用，spec §21）。 */
  bindBody: { sid: string; hash: string; t: number; mid: string };
}

async function issueAndBind(
  ctx: RelayContext,
  collector: ControlCollector,
  desktop: WebSocket,
): Promise<PhoneTicket> {
  desktop.send(JSON.stringify({ v: 1, type: "issue_session" }));
  const issued = await collector.expect((frame) => frame.type === "session_issued");
  assert.equal(issued.type, "session_issued");
  const url = new URL(issued.url);
  const bindBody = {
    sid: url.searchParams.get("sid")!,
    hash: url.searchParams.get("hash")!,
    t: Number(url.searchParams.get("t")),
    mid: url.searchParams.get("mid")!,
  };
  const bindResponse = await fetch(`${ctx.baseUrl}/api/rc/bind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bindBody),
  });
  assert.equal(bindResponse.status, 200, "bind 应成功");
  const body = (await bindResponse.json()) as { sessionToken: string; desktopName: string };
  assert.equal(body.desktopName, "测试 Mac");
  return { sid: issued.sid, sessionToken: body.sessionToken, bindBody };
}

function connectPhone(
  ctx: RelayContext,
  ticket: PhoneTicket,
  ua = "e2e-phone",
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${ctx.wsBase}/ws/phone?sid=${ticket.sid}&token=${ticket.sessionToken}&ua=${encodeURIComponent(ua)}&p2p=1`,
    );
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function wsClosed(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 close 事件超时")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function nextBinary(ws: WebSocket, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 binary 帧超时")), timeoutMs);
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      if (!isBinary) {
        reject(new Error("期望 binary 帧，收到 text"));
        return;
      }
      resolve(data as Buffer);
    });
  });
}

test("健康检查与票据 URL 形状", async () => {
  await withRelay(async (ctx) => {
    const health = await fetch(`${ctx.baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      desktop.send(JSON.stringify({ v: 1, type: "issue_session" }));
      const issued = await collector.expect((frame) => frame.type === "session_issued");
      assert.equal(issued.type, "session_issued");
      const url = new URL(issued.url);
      assert.equal(url.origin + url.pathname, "https://m.example.com/remote");
      assert.match(url.searchParams.get("sid") ?? "", /^s_/);
      assert.ok(url.searchParams.get("hash"));
      assert.ok(Number(url.searchParams.get("t")) > 0);
      assert.equal(url.searchParams.get("mid"), MID);
      assert.equal(url.searchParams.get("name"), "测试 Mac");
      assert.equal(url.searchParams.get("v"), "3.14.0-test");
      // expiresAt = t + 10min。
      assert.equal(issued.expiresAt - Number(url.searchParams.get("t")), 10 * 60_000);
    } finally {
      desktop.close();
    }
  });
});

test("全链路：桌面注册 → 签发票据 → 手机 bind → 双向 binary 透传", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      const ticket = await issueAndBind(ctx, collector, desktop);
      const phone = await connectPhone(ctx, ticket);
      try {
        const opened = await collector.expect((frame) => frame.type === "stream_open");
        assert.equal(opened.type, "stream_open");
        assert.equal(opened.sid, ticket.sid);
        assert.equal(opened.phone.ua, "e2e-phone");
        assert.equal(opened.phone.p2pCapable, true);
        const streamId = opened.streamId;

        // 手机 → 桌面：透传 binary（streamId 前缀）。
        const uplink = Buffer.from("phone-to-desktop-payload");
        phone.send(uplink);
        const desktopReceived = await nextBinary(desktop);
        const decoded = decodeRemoteControlDataFrame(new Uint8Array(desktopReceived));
        assert.ok(decoded, "数据帧应可解码");
        assert.equal(decoded.streamId, streamId);
        assert.deepEqual(Buffer.from(decoded.payload), uplink);

        // 桌面 → 手机：剥前缀透传。
        const downlink = Buffer.from("desktop-to-phone-payload");
        desktop.send(encodeRemoteControlDataFrame(streamId, new Uint8Array(downlink)), {
          binary: true,
        });
        const phoneReceived = await nextBinary(phone);
        assert.deepEqual(phoneReceived, downlink);
      } finally {
        phone.close();
        await collector.expect((frame) => frame.type === "stream_close");
      }
    } finally {
      desktop.close();
    }
  });
});

test("踢人：第二台手机连入后，第一台收 4001 且桌面收到 kicked/new open", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      const ticketA = await issueAndBind(ctx, collector, desktop);
      const phoneA = await connectPhone(ctx, ticketA, "phone-A");
      const closedA = wsClosed(phoneA);
      await collector.expect((frame) => frame.type === "stream_open");

      const ticketB = await issueAndBind(ctx, collector, desktop);
      const phoneB = await connectPhone(ctx, ticketB, "phone-B");
      try {
        const kickedClose = await collector.expect(
          (frame) => frame.type === "stream_close" && frame.reason === "kicked",
        );
        assert.equal(kickedClose.type, "stream_close");
        const opened = await collector.expect(
          (frame) => frame.type === "stream_open" && frame.sid === ticketB.sid,
        );
        assert.ok(opened.streamId !== kickedClose.streamId, "新 streamId 不复用");

        const close = await closedA;
        assert.equal(close.code, REMOTE_CONTROL_WS_CLOSE.KICKED);
        assert.equal(close.reason, "superseded");

        // 被顶替设备凭原 token 重连收 4001（spec §21.6：据此展示「已在其他设备登录」）。
        const reconnect = new WebSocket(
          `${ctx.wsBase}/ws/phone?sid=${ticketA.sid}&token=${ticketA.sessionToken}`,
        );
        const reconnectClose = await wsClosed(reconnect);
        assert.equal(reconnectClose.code, REMOTE_CONTROL_WS_CLOSE.KICKED);
      } finally {
        phoneB.close();
      }
    } finally {
      desktop.close();
    }
  });
});

test("踢人：grace 中的旧手机同样被新设备顶下线", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      const ticketA = await issueAndBind(ctx, collector, desktop);
      const phoneA = await connectPhone(ctx, ticketA, "phone-A");
      const closedA = wsClosed(phoneA);
      await collector.expect((frame) => frame.type === "stream_open");
      // A 断线进入 grace（数据管道已关，但可能还挂着信令管道）。
      phoneA.close();
      await collector.expect((frame) => frame.type === "stream_close" && frame.reason === "lost");

      const signalA = new WebSocket(
        `${ctx.wsBase}/ws/signal?sid=${ticketA.sid}&token=${ticketA.sessionToken}`,
      );
      await new Promise<void>((resolve) => signalA.once("open", resolve));
      const signalAClosed = wsClosed(signalA);

      // B 扫码连入：A 的信令管道也被关闭，A 会话作废。
      const ticketB = await issueAndBind(ctx, collector, desktop);
      const phoneB = await connectPhone(ctx, ticketB, "phone-B");
      try {
        await collector.expect(
          (frame) => frame.type === "stream_open" && frame.sid === ticketB.sid,
        );
        const signalClose = await signalAClosed;
        assert.equal(signalClose.code, REMOTE_CONTROL_WS_CLOSE.KICKED);
        assert.equal(ctx.handle.state.sessions.get(ticketA.sid)?.state, "closed");
        await closedA; // A 的数据管道 close 事件（已被 relay 提前关闭）。
      } finally {
        phoneB.close();
      }
    } finally {
      desktop.close();
    }
  });
});

test("grace 重连：手机断开后 5min 内同 token 重连成功", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      const ticket = await issueAndBind(ctx, collector, desktop);
      const phone1 = await connectPhone(ctx, ticket);
      const firstOpen = await collector.expect((frame) => frame.type === "stream_open");
      phone1.close();
      const lost = await collector.expect(
        (frame) => frame.type === "stream_close" && frame.reason === "lost",
      );
      assert.equal(lost.type, "stream_close");

      // 同 token 立即重连（grace 语义）。
      const phone2 = await connectPhone(ctx, ticket, "phone-reconnected");
      try {
        const reopened = await collector.expect((frame) => frame.type === "stream_open");
        assert.equal(reopened.sid, ticket.sid);
        assert.ok(reopened.streamId > firstOpen.streamId, "重连使用新 streamId");
      } finally {
        phone2.close();
      }
    } finally {
      desktop.close();
    }
  });
});

test("桌面离线：手机管道收 4002；桌面回来后手机重连成功", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    const ticket = await issueAndBind(ctx, collector, desktop);
    const phone = await connectPhone(ctx, ticket);
    const phoneClosed = wsClosed(phone);
    await collector.expect((frame) => frame.type === "stream_open");

    desktop.close();
    const close = await phoneClosed;
    assert.equal(close.code, REMOTE_CONTROL_WS_CLOSE.DESKTOP_OFFLINE);

    // 桌面离线期间重连 → 升级后立即 4002。
    const midOffline = new WebSocket(
      `${ctx.wsBase}/ws/phone?sid=${ticket.sid}&token=${ticket.sessionToken}`,
    );
    const offlineClose = await wsClosed(midOffline);
    assert.equal(offlineClose.code, REMOTE_CONTROL_WS_CLOSE.DESKTOP_OFFLINE);

    // 桌面回归 → 手机重连成功。
    const desktop2 = await connectDesktop(ctx, collector);
    try {
      const phone2 = await connectPhone(ctx, ticket, "phone-after-desktop-back");
      try {
        const reopened = await collector.expect((frame) => frame.type === "stream_open");
        assert.equal(reopened.sid, ticket.sid);
      } finally {
        phone2.close();
      }
    } finally {
      desktop2.close();
    }
  });
});

test("票据安全：篡改 hash / 错误 mid 全部拒绝；正确票据可多次 bind", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      desktop.send(JSON.stringify({ v: 1, type: "issue_session" }));
      const issued = await collector.expect((frame) => frame.type === "session_issued");
      assert.equal(issued.type, "session_issued");
      const url = new URL(issued.url);
      const sid = url.searchParams.get("sid")!;
      const hash = url.searchParams.get("hash")!;
      const t = Number(url.searchParams.get("t"));

      const attempt = async (body: Record<string, unknown>) => {
        const response = await fetch(`${ctx.baseUrl}/api/rc/bind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, token: (await response.json()).sessionToken };
      };
      // 失败次数控制在限频惩罚预算内（strike 指数放大），t 篡改场景由 state 单测覆盖。
      assert.equal((await attempt({ sid, hash: "tampered", t, mid: MID })).status, 401);
      assert.equal((await attempt({ sid, hash, t, mid: "mid-attacker" })).status, 401);

      // 正确票据多次 bind（spec §21.1 设备转移）：每次签发新 sessionToken。
      const first = await attempt({ sid, hash, t, mid: MID });
      assert.equal(first.status, 200);
      const second = await attempt({ sid, hash, t, mid: MID });
      assert.equal(second.status, 200);
      assert.notEqual(second.token, first.token);

      // 长效票据（persistent）：session_issued 的 expiresAt 为 null。
      desktop.send(JSON.stringify({ v: 1, type: "issue_session", persistent: true }));
      const persistentIssued = await collector.expect(
        (frame) => frame.type === "session_issued" && frame.url !== issued.url,
      );
      assert.equal(persistentIssued.type, "session_issued");
      assert.equal(persistentIssued.expiresAt, null);
    } finally {
      desktop.close();
    }
  });
});

test("disconnect_session：手机收 4006，票据保留可重连（spec §21.2）", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      const ticket = await issueAndBind(ctx, collector, desktop);
      const phone = await connectPhone(ctx, ticket);
      try {
        await collector.expect((frame) => frame.type === "stream_open");

        const phoneClosed = new Promise<{ code: number; reason: string }>((resolve) => {
          phone.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
        });
        desktop.send(JSON.stringify({ v: 1, type: "disconnect_session", sid: ticket.sid }));
        const closed = await phoneClosed;
        assert.equal(closed.code, 4006);
        const streamClose = await collector.expect(
          (frame) => frame.type === "stream_close" && frame.reason === "phone_stop",
        );
        assert.equal(streamClose.type, "stream_close");

        // 同一票据重新 bind → 新 token，手机可再次接入。
        const rebindResponse = await fetch(`${ctx.baseUrl}/api/rc/bind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ticket.bindBody),
        });
        assert.equal(rebindResponse.status, 200);
        const { sessionToken } = (await rebindResponse.json()) as { sessionToken: string };
        assert.notEqual(sessionToken, ticket.sessionToken);
        const phone2 = await connectPhone(ctx, { ...ticket, sessionToken });
        phone2.close();
      } finally {
        phone.close();
      }
    } finally {
      desktop.close();
    }
  });
});

test("bind 限频：超限收 429", async () => {
  await withRelay(async (ctx) => {
    // 本用例独立 relay，先把桶耗尽再验证 429。
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${ctx.baseUrl}/api/rc/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid: "s_x", hash: "x", t: 1, mid: "m" }),
      });
      assert.ok(response.status === 401 || response.status === 429);
    }
    const response = await fetch(`${ctx.baseUrl}/api/rc/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: "s_x", hash: "x", t: 1, mid: "m" }),
    });
    assert.equal(response.status, 429);
  });
});

test("非法凭证：desktop token 错误拒绝升级", async () => {
  await withRelay(async (ctx) => {
    await assert.rejects(
      () =>
        new Promise((_, reject) => {
          const ws = new WebSocket(`${ctx.wsBase}/ws/desktop?mid=${MID}&token=bad-token`);
          ws.once("error", (error) => reject(error));
          ws.once("open", () => reject(new Error("不应升级成功")));
        }),
      (error: unknown) => error instanceof Error,
    );
  });
});

test("v2 信令：config 注入 + rtc_signal 双向透传", async () => {
  await withRelay(async (ctx) => {
    const collector = new ControlCollector();
    const desktop = await connectDesktop(ctx, collector);
    try {
      const ticket = await issueAndBind(ctx, collector, desktop);
      const phone = await connectPhone(ctx, ticket);
      try {
        await collector.expect((frame) => frame.type === "stream_open");
        const signal = new WebSocket(
          `${ctx.wsBase}/ws/signal?sid=${ticket.sid}&token=${ticket.sessionToken}`,
        );
        // relay 在连接建立瞬间即下发 config，可能与 open 同一 TCP 段到达：
        // 必须从构造起就缓存全部消息，避免 once("message") 注册晚于首帧。
        const signalMessages: string[] = [];
        signal.on("message", (data) => signalMessages.push(data.toString("utf8")));
        const signalJson = async (
          match: (parsed: unknown) => boolean,
          timeoutMs = 5000,
        ): Promise<string> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const index = signalMessages.findIndex((raw) => {
              try {
                return match(JSON.parse(raw));
              } catch {
                return false;
              }
            });
            if (index >= 0) {
              return signalMessages.splice(index, 1)[0]!;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error("信令超时");
        };
        await new Promise<void>((resolve, reject) => {
          signal.once("open", resolve);
          signal.once("error", reject);
        });

        // relay 注入 STUN 配置。
        const config = JSON.parse(
          await signalJson((parsed) => (parsed as { kind?: string }).kind === "config"),
        ) as { kind: string; iceServers: { urls: string[] } };
        assert.equal(config.kind, "config");
        assert.deepEqual(config.iceServers.urls, ["stun:stun.example.com:3478"]);

        // 手机 → 桌面信令。
        signal.send(JSON.stringify({ kind: "p2p_request" }));
        const request = await collector.expect((frame) => frame.type === "rtc_signal");
        assert.equal(request.type, "rtc_signal");
        assert.deepEqual(request.data, { kind: "p2p_request" });

        // 桌面 → 手机信令。
        desktop.send(
          JSON.stringify({
            v: 1,
            type: "rtc_signal",
            streamId: request.streamId,
            data: { kind: "offer", sdp: "v=0..." },
          }),
        );
        const answer = await signalJson((parsed) => (parsed as { kind?: string }).kind === "offer");
        assert.deepEqual(JSON.parse(answer), { kind: "offer", sdp: "v=0..." });
        signal.close();
      } finally {
        phone.close();
      }
    } finally {
      desktop.close();
    }
  });
});
