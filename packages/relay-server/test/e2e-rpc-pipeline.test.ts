import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import type { MessagePort as WorkerMessagePort } from "node:worker_threads";
import { WebSocket } from "ws";
import { startRelayServer } from "../src/server.js";
import {
  ChannelClient,
  ChannelServer,
  MessagePortProtocol,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type MessagePortLike,
} from "@zcode/rpc";
import type { PumpPort } from "../../desktop/src/main/remoteControl/streamPump.js";
import { createMobileStreamPump } from "../../desktop/src/main/remoteControl/streamPump.js";
import {
  RelayConnection,
  createWsTransportFactory,
} from "../../desktop/src/main/remoteControl/relayConnection.js";
import type { RemoteControlDesktopFrame } from "@zcode/shared/remote-control";

/**
 * 全链路 E2E（spec §12 场景 1/3 的数据面）：真实 relay + 真实 WS + 真实 RPC 协议栈。
 *
 * 手机侧: ChannelClient ↔ SocketProtocol(13B 分帧) ↔ ws ↔ relay ↔ ws ↔ RelayConnection
 * 桌面侧: RelayConnection 解码 → 真实泵(剥/补帧头) ↔ worker_threads MessagePort ↔
 *         MessagePortProtocol ↔ ChannelServer ↔ 测试服务（ProxyChannel）。
 * 仅两处等价替换：Electron MessagePortMain → worker_threads MessagePort（同构接口）；
 * Main 侧编排（attach/supersede）已由 desktop service 单测覆盖，本测试专注数据面正确性。
 */

const MID = "mid-e2e";

interface E2eChannel {
  echo(text: string): Promise<string>;
  add(a: number, b: number): Promise<number>;
}

/** Node ws 客户端 → ISocket（与 packages/server/src/http.ts wrapWebSocket 同构）。 */
class NodeWsSocket implements ISocket {
  private dataListeners: Array<(buffer: VSBuffer) => void> = [];
  private closeListeners: Array<() => void> = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      const buffer = VSBuffer.wrap(new Uint8Array(data));
      for (const listener of this.dataListeners) {
        listener(buffer);
      }
    });
    ws.on("close", () => {
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  readonly onData = (listener: (buffer: VSBuffer) => void) => {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  };
  readonly onClose = (listener: () => void) => {
    this.closeListeners.push(listener);
    return { dispose: () => {} };
  };
  readonly onEnd = () => ({ dispose: () => {} });

  write(buffer: VSBuffer): void {
    this.ws.send(buffer.buffer, { binary: true });
  }

  end(): void {
    this.ws.close();
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.ws.terminate();
  }
}

/** worker_threads MessagePort → PumpPort（Main 侧视角，{data} 事件形状）。 */
function asPumpPort(port: WorkerMessagePort): PumpPort {
  return {
    on(event: "message" | "close", listener: never) {
      if (event === "message") {
        port.on("message", (value) =>
          (listener as (event: { data: unknown }) => void)({ data: value }),
        );
      } else {
        port.on("close", () => (listener as () => void)());
      }
      return undefined;
    },
    postMessage(message) {
      port.postMessage(message);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

/** worker_threads MessagePort → rpc MessagePortLike（Host 侧视角，addEventListener 形状）。 */
function asHostPort(port: WorkerMessagePort): MessagePortLike {
  const messageHandlers = new Set<(e: { data: unknown }) => void>();
  port.on("message", (value) => {
    for (const handler of messageHandlers) {
      handler({ data: value });
    }
  });
  return {
    addEventListener(_type, listener) {
      messageHandlers.add(listener);
    },
    removeEventListener(_type, listener) {
      messageHandlers.delete(listener);
    },
    postMessage(message) {
      port.postMessage(message);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

const echoService = {
  echo: async (text: string) => `echo:${text}`,
  add: async (a: number, b: number) => a + b,
  bigPayload: async (blob: string) => blob.length,
};

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("等待超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface PhoneClient {
  ws: WebSocket;
  channel: E2eChannel & { bigPayload(blob: string): Promise<number> };
  closed: Promise<{ code: number; reason: string }>;
}

test("真实 RPC 管道：手机经 relay 与桌面 Host 双向通信、踢人、grace 重连", async () => {
  const relay = await startRelayServer({
    secret: "e2e-secret",
    webRemoteBase: "https://m.example.com/remote",
    publicWsBase: "ws://127.0.0.1:0",
  });
  const baseUrl = `http://127.0.0.1:${relay.port}`;
  const wsBase = `ws://127.0.0.1:${relay.port}`;
  const phoneSockets: WebSocket[] = [];
  // 清理句柄提升到 try 外：finally 需要访问（try 内声明的变量对 finally 不可见）。
  let pump: ReturnType<typeof createMobileStreamPump> | null = null;
  let connection: RelayConnection | undefined;
  let hostChannel: MessageChannel | null = null;

  try {
    // —— 桌面侧准备：relay 长连 + 延迟 attachment（生产时序：stream_open 才建 Host 侧）——
    // ChannelServer 构造即向对端发 Initialize 握手；若早于手机连入创建，握手帧会漏进
    // relay 无人接收，手机 ChannelClient 将永久等待。因此 Host 侧（port/ChannelServer/泵）
    // 必须在收到 stream_open 后创建——与桌面 service.ts 的 attach 编排一致。
    const registerResponse = await fetch(`${baseUrl}/api/rc/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mid: MID, name: "E2E Mac", appVersion: "3.14.0" }),
    });
    const { deviceToken } = (await registerResponse.json()) as { deviceToken: string };

    const desktopFrames: RemoteControlDesktopFrame[] = [];
    let activeStreamId = -1;
    const attachHost = (): void => {
      hostChannel?.port1.close();
      const channel = new MessageChannel();
      hostChannel = channel;
      const hostServer = new ChannelServer(
        new MessagePortProtocol(asHostPort(channel.port2)),
        "host",
      );
      hostServer.registerChannel("e2e", ProxyChannel.fromService(echoService));
      pump = createMobileStreamPump({
        port: asPumpPort(channel.port1),
        sendWireBytes: (framed) => conn.sendStreamBinary(activeStreamId, framed),
        notifyClosed: () => conn.sendStreamCloseNotify(activeStreamId),
      });
    };
    const conn = new RelayConnection(
      `${wsBase}/ws/desktop?mid=${MID}&token=${deviceToken}`,
      createWsTransportFactory(WebSocket),
      {
        onFrame: (frame) => desktopFrames.push(frame),
        onBinary: (streamId, payload) => {
          if (streamId === activeStreamId) {
            pump?.handleWireBytes(payload);
          }
        },
        onClosed: () => {},
      },
    );
    connection = conn;
    conn.connect();
    connection.sendRegister({ mid: MID, token: deviceToken, name: "E2 Mac", appVersion: "3.14.0" });
    await waitFor(() =>
      desktopFrames.some((frame) => frame.type === "register_ok") ? 1 : undefined,
    );

    /** 模拟 Main 编排：stream_open 后新建 Host 侧 attachment（新 ChannelServer 会向新手机发 Initialize 握手）。 */
    const takeOverStream = async (): Promise<number> => {
      const opened = await waitFor(() =>
        desktopFrames.find((frame) => frame.type === "stream_open"),
      );
      assert.equal(opened.type, "stream_open");
      desktopFrames.splice(desktopFrames.indexOf(opened), 1);
      activeStreamId = opened.streamId;
      pump?.dispose();
      attachHost();
      return opened.streamId;
    };

    const issueAndBind = async (): Promise<{ sid: string; token: string }> => {
      conn.sendIssueSession();
      const issued = await waitFor(() =>
        desktopFrames.find((frame) => frame.type === "session_issued" && !("used" in frame)),
      );
      assert.equal(issued.type, "session_issued");
      const url = new URL(issued.url);
      // spec §5.3 增补：票据 URL 必须携带运行时 WS 基址（域名迁移免重建手机页）。
      assert.equal(url.searchParams.get("ws"), "ws://127.0.0.1:0");
      desktopFrames.splice(desktopFrames.indexOf(issued), 1);
      const bindResponse = await fetch(`${baseUrl}/api/rc/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sid: url.searchParams.get("sid"),
          hash: url.searchParams.get("hash"),
          t: Number(url.searchParams.get("t")),
          mid: url.searchParams.get("mid"),
        }),
      });
      assert.equal(bindResponse.status, 200);
      return {
        sid: issued.sid,
        token: ((await bindResponse.json()) as { sessionToken: string }).sessionToken,
      };
    };

    const connectPhone = async (
      ticket: { sid: string; token: string },
      ua: string,
    ): Promise<PhoneClient> => {
      const ws = new WebSocket(
        `${wsBase}/ws/phone?sid=${ticket.sid}&token=${ticket.token}&ua=${encodeURIComponent(ua)}&p2p=1`,
      );
      phoneSockets.push(ws);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const client = new ChannelClient(new SocketProtocol(new NodeWsSocket(ws)));
      return {
        ws,
        channel: ProxyChannel.toService<typeof echoService>(client.getChannel("e2e")),
        closed,
      };
    };

    // —— 场景 1：首次连接 + RPC 双向 ——
    const ticketA = await issueAndBind();
    const phoneA = await connectPhone(ticketA, "phone-A");
    await takeOverStream();

    assert.equal(await phoneA.channel.echo("hello"), "echo:hello");
    assert.equal(await phoneA.channel.add(19, 23), 42);
    // 大载荷（跨多个 chunk 的序列化内容）验证分帧翻译边界。
    const bigBlob = "x".repeat(256 * 1024);
    assert.equal(await phoneA.channel.bigPayload(bigBlob), bigBlob.length);
    // 再次调用确认多路复用稳定。
    assert.equal(await phoneA.channel.echo("again"), "echo:again");

    // —— 场景 3：踢人 ——
    const ticketB = await issueAndBind();
    const phoneB = await connectPhone(ticketB, "phone-B");
    const closedA = phoneA.closed;
    await takeOverStream(); // 桌面编排：新 stream 接管泵。
    const closeInfo = await closedA;
    assert.equal(closeInfo.code, 4001, "旧手机被顶替下线");
    // 新手机可正常 RPC。
    assert.equal(await phoneB.channel.echo("from-b"), "echo:from-b");

    // —— 场景 4：grace 重连 ——
    phoneB.ws.close();
    await waitFor(() =>
      desktopFrames.find((frame) => frame.type === "stream_close" && frame.reason === "lost"),
    );
    const phoneB2 = await connectPhone(ticketB, "phone-B-reconnect");
    await takeOverStream();
    assert.equal(
      await phoneB2.channel.echo("resumed"),
      "echo:resumed",
      "同 token 重连后立即恢复可用",
    );

    phoneB2.ws.close();
  } finally {
    for (const ws of phoneSockets) {
      try {
        ws.close();
      } catch {
        // 已关闭。
      }
    }
    // 泵/端口/连接不清理会让 worker MessageChannel 与 ws 句柄悬挂，测试进程无法退出。
    pump?.dispose();
    connection?.close();
    hostChannel?.port1.close();
    hostChannel?.port2.close();
    await relay.close();
  }
});

test("v2 P2P 升级全流程：信令经真实 relay 交换，dc-open 后中转管道按 4005 退役", async () => {
  const { createRtcController } =
    await import("../../desktop/src/main/remoteControl/rtc/rtcController.js");
  const relay = await startRelayServer({
    secret: "e2e-secret",
    webRemoteBase: "https://m.example.com/remote",
    publicWsBase: "ws://127.0.0.1:0",
  });
  const baseUrl = `http://127.0.0.1:${relay.port}`;
  const wsBase = `ws://127.0.0.1:${relay.port}`;
  try {
    const registerResponse = await fetch(`${baseUrl}/api/rc/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mid: MID, name: "E2E Mac", appVersion: "3.14.0" }),
    });
    const { deviceToken } = (await registerResponse.json()) as { deviceToken: string };

    const desktopFrames: RemoteControlDesktopFrame[] = [];
    const connection = new RelayConnection(
      `${wsBase}/ws/desktop?mid=${MID}&token=${deviceToken}`,
      createWsTransportFactory(WebSocket),
      {
        onFrame: (frame) => desktopFrames.push(frame),
        onBinary: () => {},
        onClosed: () => {},
      },
    );
    connection.connect();
    connection.sendRegister({ mid: MID, token: deviceToken, name: "Mac", appVersion: "3.14.0" });
    await waitFor(() =>
      desktopFrames.some((frame) => frame.type === "register_ok") ? 1 : undefined,
    );

    connection.sendIssueSession();
    const issued = await waitFor(() =>
      desktopFrames.find((frame) => frame.type === "session_issued"),
    );
    assert.equal(issued.type, "session_issued");
    const ticketUrl = new URL(issued.url);
    const bindResponse = await fetch(`${baseUrl}/api/rc/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sid: ticketUrl.searchParams.get("sid"),
        hash: ticketUrl.searchParams.get("hash"),
        t: Number(ticketUrl.searchParams.get("t")),
        mid: ticketUrl.searchParams.get("mid"),
      }),
    });
    const { sessionToken } = (await bindResponse.json()) as { sessionToken: string };
    const sid = issued.sid;

    // 手机数据管道 + 信令管道（伪造 WebRTC 端：不做真实打洞，验证信令与退役语义）。
    const phoneWs = new WebSocket(`${wsBase}/ws/phone?sid=${sid}&token=${sessionToken}`);
    await new Promise<void>((resolve, reject) => {
      phoneWs.once("open", resolve);
      phoneWs.once("error", reject);
    });
    const opened = await waitFor(() => desktopFrames.find((frame) => frame.type === "stream_open"));
    assert.equal(opened.type, "stream_open");

    const signalMessages: string[] = [];
    const signal = new WebSocket(`${wsBase}/ws/signal?sid=${sid}&token=${sessionToken}`);
    signal.on("message", (data) => signalMessages.push(data.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      signal.once("open", resolve);
      signal.once("error", reject);
    });
    const nextSignal = async (kind: string): Promise<Record<string, unknown>> => {
      const found = await waitFor(() =>
        signalMessages
          .map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .find((parsed) => parsed.kind === kind),
      );
      signalMessages.splice(
        signalMessages.findIndex(
          (raw) => (JSON.parse(raw) as Record<string, unknown>).kind === kind,
        ),
        1,
      );
      return found;
    };
    await nextSignal("config"); // relay 注入 STUN。

    // 真实 rtcController + 伪造窗口。
    const windowCommands: Array<{ command: unknown; transferCount: number }> = [];
    const attaches: number[] = [];
    let windowListener: ((event: { type: string } & Record<string, unknown>) => void) | null = null;
    const controller = createRtcController({
      createWindow: () => ({
        sendCommand: (command, transfer) =>
          windowCommands.push({ command, transferCount: transfer?.length ?? 0 }),
        onEvent: (listener) => {
          windowListener = listener as never;
          return () => {
            windowListener = null;
          };
        },
        destroy: () => {},
      }),
      sendSignal: (streamId, data) => connection.sendRtcSignal(streamId, data),
      attachPort: (webContentsId) => {
        attaches.push(webContentsId);
        return {
          attachmentId: `p2p-${attaches.length}`,
          port: { on: () => {}, postMessage: () => {}, close: () => {} },
        };
      },
      detachPort: () => {},
      activeWebContentsId: () => 7,
      onTransportChanged: () => {},
      iceServers: { urls: ["stun:test:3478"] },
      logger: { info: () => {}, warn: () => {} },
    });
    // service 的信令接线。
    const originalOnFramePush = desktopFrames.push.bind(desktopFrames);
    desktopFrames.push = ((frame: RemoteControlDesktopFrame) => {
      if (frame.type === "rtc_signal") {
        controller.handleSignal(frame.streamId, frame.data);
      }
      return originalOnFramePush(frame);
    }) as typeof desktopFrames.push;

    // 手机发起 p2p_request → 控制器开窗协商 → 窗口出 offer → 手机收 offer 回 answer。
    signal.send(JSON.stringify({ kind: "p2p_request" }));
    await waitFor(() => (windowCommands.length > 0 ? 1 : undefined));
    assert.deepEqual(windowCommands[0]?.command, {
      type: "negotiate",
      iceServers: { urls: ["stun:test:3478"] },
    });
    windowListener?.({ type: "offer", sdp: "v=0-offer" });
    const offer = await nextSignal("offer");
    assert.equal(offer.sdp, "v=0-offer", "offer 经真实 relay 送达手机");

    signal.send(JSON.stringify({ kind: "answer", sdp: "v=0-answer" }));
    await waitFor(() =>
      windowCommands.some((entry) => (entry.command as { type?: string }).type === "answer")
        ? 1
        : undefined,
    );

    // dc-open：控制器挂 p2p attachment 并转移端口。
    windowListener?.({ type: "dc-open" });
    await waitFor(() => (attaches.length > 0 ? 1 : undefined));
    const bindCommand = windowCommands.find(
      (entry) => (entry.command as { type?: string }).type === "bind-port",
    );
    assert.ok(bindCommand, "bind-port 已下发");
    assert.equal(bindCommand?.transferCount, 1);
    assert.equal(controller.isActive(), true);

    // 手机关闭中转数据管道（P2P 升级）→ relay → 桌面收到 stream_close(p2p_promoted)。
    phoneWs.close(4005, "p2p-promoted");
    const promoted = await waitFor(() =>
      desktopFrames.find(
        (frame) => frame.type === "stream_close" && frame.reason === "p2p_promoted",
      ),
    );
    assert.equal(promoted.type, "stream_close");
    signal.close();
    phoneWs.close();
    connection.close();
  } finally {
    await relay.close();
  }
});
