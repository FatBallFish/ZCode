import assert from "node:assert/strict";
import test from "node:test";
import {
  createRtcController,
  type RtcWindowHandle,
} from "../../src/main/remoteControl/rtc/rtcController.js";
import type { RemoteControlRtcCommand, RemoteControlRtcEvent } from "@zcode/shared/remote-control";

/**
 * rtcController 状态机单测（spec §9.3/§9.4）：假窗口 + 手动定时器。
 * 真实 relay 信令通路在 relay-server 的 E2E 中覆盖。
 */

let p2pLostCalls = 0;

function createHarness() {
  const commands: Array<{ command: RemoteControlRtcCommand; transferCount: number }> = [];
  const signals: Array<{ streamId: number; kind: string }> = [];
  const attaches: number[] = [];
  const detaches: string[] = [];
  const transports: string[] = [];
  const windows: FakeWindow[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let timerSeq = 0;

  class FakeWindow implements RtcWindowHandle {
    sendCommand(command: RemoteControlRtcCommand, transfer?: unknown[]): void {
      commands.push({ command, transferCount: transfer?.length ?? 0 });
    }
    onEvent(listener: (event: RemoteControlRtcEvent) => void): () => void {
      this.listener = listener;
      return () => {
        this.listener = null;
      };
    }
    destroy(): void {
      this.destroyed = true;
    }
    listener: ((event: RemoteControlRtcEvent) => void) | null = null;
    destroyed = false;
    emit(event: RemoteControlRtcEvent): void {
      this.listener?.(event);
    }
  }

  const controller = createRtcController({
    createWindow: () => {
      const win = new FakeWindow();
      windows.push(win);
      return win;
    },
    sendSignal: (streamId, data) => signals.push({ streamId, kind: data.kind }),
    attachPort: (webContentsId) => {
      attaches.push(webContentsId);
      return {
        attachmentId: `attach-${attaches.length}`,
        port: { on: () => {}, postMessage: () => {}, close: () => {} },
      };
    },
    detachPort: (_webContentsId, attachmentId) => detaches.push(attachmentId),
    activeWebContentsId: () => 7,
    onTransportChanged: (transport) => transports.push(transport),
    onP2pLost: () => {
      p2pLostCalls += 1;
    },
    iceServers: { urls: ["stun:test:3478"] },
    logger: { info: () => {}, warn: () => {} },
    setTimeout: (handler, ms) => {
      timerSeq += 1;
      const id = timerSeq;
      timers.push({ fn: handler, ms });
      return id;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((_, i) => i + 1 === (handle as number));
      if (index >= 0) {
        timers.splice(index, 1);
      }
    },
  });

  const fireTimers = () => {
    for (const timer of timers.splice(0)) {
      timer.fn();
    }
  };

  return {
    controller,
    commands,
    signals,
    attaches,
    detaches,
    transports,
    windows,
    fireTimers,
  };
}

test("完整升级流：p2p_request → 窗口协商 → dc-open → 端口绑定 + transport=p2p", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  assert.equal(h.windows.length, 1, "创建隐藏窗口");
  assert.deepEqual(h.commands[0]?.command, {
    type: "negotiate",
    iceServers: { urls: ["stun:test:3478"] },
  });

  const win = h.windows[0]!;
  win.emit({ type: "offer", sdp: "v=0" });
  assert.deepEqual(h.signals.at(-1), { streamId: 4, kind: "offer" });
  h.controller.handleSignal(4, { kind: "answer", sdp: "v=0 answer" });
  assert.equal(h.commands.at(-1)?.command.type, "answer");
  win.emit({ type: "ice", candidate: { candidate: "x" } });
  h.controller.handleSignal(4, { kind: "ice", candidate: { candidate: "y" } });

  win.emit({ type: "dc-open" });
  assert.deepEqual(h.attaches, [7], "dc-open 后挂 p2p attachment");
  assert.deepEqual(h.transports, ["p2p"]);
  const bindCommand = h.commands.find((entry) => entry.command.type === "bind-port");
  assert.ok(bindCommand, "下发 bind-port");
  assert.equal(bindCommand?.transferCount, 1, "附带转移一个 MessagePort");
  assert.equal(h.controller.isActive(), true);

  // dispose：拆 p2p attachment + 销毁窗口。
  h.controller.dispose();
  assert.deepEqual(h.detaches, ["attach-1"]);
  assert.equal(win.destroyed, true);
});

test("信令预算超时：保持中转、窗口销毁", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  h.fireTimers(); // 15s 预算到点。
  assert.equal(h.controller.isNegotiating(), false);
  assert.equal(h.windows[0]?.destroyed, true);
  assert.deepEqual(h.transports, [], "transport 不变（中转）");
});

test("失败后冷却：冷却期内拒绝协商（回 reject 信令，不建窗口）", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  h.fireTimers(); // 超时失败 → 进入冷却。
  h.controller.handleSignal(5, { kind: "p2p_request" });
  assert.equal(h.windows.length, 1, "冷却期内不再创建新窗口");
  assert.deepEqual(h.signals.at(-1), { streamId: 5, kind: "reject" });
});

test("协商中被拒（phone reject）：立即失败回收", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  h.controller.handleSignal(4, { kind: "reject", reason: "no-webrtc" });
  assert.equal(h.controller.isNegotiating(), false);
  assert.equal(h.windows[0]?.destroyed, true);
});

test("dc 断开：拆 p2p attachment、transport 回 relay，等手机回退中转", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  h.windows[0]!.emit({ type: "offer", sdp: "s" });
  h.windows[0]!.emit({ type: "dc-open" });
  assert.equal(h.controller.isActive(), true);
  h.windows[0]!.emit({ type: "dc-closed" });
  assert.equal(h.controller.isActive(), false);
  assert.deepEqual(h.detaches, ["attach-1"]);
  assert.deepEqual(h.transports, ["p2p", "relay"]);
});

test("协商中收到重复 p2p_request：拒绝（单会话）", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  h.controller.handleSignal(9, { kind: "p2p_request" });
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.signals.at(-1), { streamId: 9, kind: "reject" });
});

test("P2P 硬上限：累计失败 5 次后永久拒绝（跨冷却窗口），dispose 重置（spec §21.9）", () => {
  const windows: { destroyed: boolean }[] = [];
  const signals: Array<{ streamId: number; kind: string; reason?: string }> = [];
  const timers: Array<() => void> = [];
  let clock = 1_000_000;
  const controller = createRtcController({
    createWindow: () => {
      const record = { destroyed: false };
      windows.push(record);
      return {
        sendCommand: () => {},
        onEvent: () => () => {},
        destroy: () => {
          record.destroyed = true;
        },
      };
    },
    sendSignal: (streamId, data) => {
      signals.push({
        streamId,
        kind: data.kind,
        ...(data.kind === "reject" ? { reason: data.reason } : {}),
      });
    },
    attachPort: () => {
      throw new Error("unused");
    },
    detachPort: () => {},
    activeWebContentsId: () => 1,
    onTransportChanged: () => {},
    onP2pLost: () => {
      p2pLostCalls += 1;
    },
    iceServers: { urls: [] },
    logger: { info: () => {}, warn: () => {} },
    setTimeout: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeout: () => {},
    now: () => clock,
  });
  // 5 轮失败，每轮跨过 10min 冷却窗口（硬上限按总量累计，冷却只影响节奏）。
  for (let i = 0; i < 5; i++) {
    controller.handleSignal(4, { kind: "p2p_request" });
    for (const fire of timers.splice(0)) {
      fire(); // 信令预算超时 → fail。
    }
    clock += 11 * 60_000; // 越过冷却窗口。
  }
  assert.equal(windows.length, 5, "每轮都真实协商");
  // 第 6 次：硬上限直接拒绝 p2p-disabled（即使已过冷却）。
  controller.handleSignal(5, { kind: "p2p_request" });
  assert.equal(windows.length, 5, "达上限不再创建窗口");
  assert.deepEqual(signals.at(-1), { streamId: 5, kind: "reject", reason: "p2p-disabled" });
  // dispose（stop）后计数重置，可重新协商。
  controller.dispose();
  controller.handleSignal(6, { kind: "p2p_request" });
  assert.equal(windows.length, 6, "dispose 后重新允许协商");
});

test("dc 断开时通知 service P2P 会话丢失（spec §21.10）", () => {
  p2pLostCalls = 0;
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  const win = h.windows[0]!;
  // dc 上线（attachment 绑定，p2pActive=true）。
  win.emit({ type: "dc-open" });
  assert.equal(p2pLostCalls, 0);
  // dc 断开 → onP2pLost 一次。
  win.emit({ type: "dc-closed" });
  assert.equal(p2pLostCalls, 1, "p2p 活跃期间断开必须通知 service");
  // 未上线时断开（协商中断开）不通知。
  h.controller.handleSignal(5, { kind: "p2p_request" });
  h.windows[1]?.emit({ type: "dc-closed" });
  assert.equal(p2pLostCalls, 1);
  p2pLostCalls = 0;
});

test("在线会话丢失不计入失败上限、不进冷却（spec §21.10）", () => {
  const h = createHarness();
  h.controller.handleSignal(4, { kind: "p2p_request" });
  h.windows[0]!.emit({ type: "dc-open" }); // 上线。
  // 模拟 ICE 心跳超时：failed 事件。
  h.windows[0]!.emit({ type: "failed", reason: "connection-failed" });
  // 立即再次协商：不应被冷却拒绝。
  h.controller.handleSignal(5, { kind: "p2p_request" });
  assert.equal(h.windows.length, 2, "会话丢失后立即可重新协商");
  assert.ok(!h.signals.some((signal) => signal.kind === "reject"), "无 reject");
});
