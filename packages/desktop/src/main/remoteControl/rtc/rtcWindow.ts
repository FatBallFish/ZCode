import { BrowserWindow } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { RemoteControlRtcCommand, RemoteControlRtcEvent } from "@zcode/shared/remote-control";
import type { RtcWindowHandle } from "./rtcController.js";

/**
 * 隐藏 RTC 窗口（spec §9.1）：Chromium 完整 WebRTC 栈，不引入原生模块。
 * preload 复用主窗口 bridge（暴露 zcode IPC 面）；WebRTC 胶水经 executeJavaScript 注入，
 * 窗口内完成 PeerConnection/DataChannel 与被转移 MessagePort 的桥接。
 */

const RTC_GLUE_SCRIPT = `
(() => {
  const state = { pc: null, dc: null, port: null };
  // 诊断日志经 console 输出，由 Main 的 console-message 转发落盘（P2P 真实失败原因排查）。
  const log = (m) => { try { console.log("[rtc-glue] " + m); } catch {} };

  function emit(event) {
    window.zcode?.sendRemoteControlRtcEvent?.(event);
  }

  let dcStats = { received: 0, sent: 0 };

  // 大消息分片（spec §21.9）：DataChannel 单消息受 SCTP 协商上限（远小于 WS 的 8MB），
  // 快照类大消息（实测 378KB）直接 dc.send 会把通道打死（2026-09-24 真机定位）。
  // 帧格式：kind=0x00 裸小消息；kind=0x01 分片：u32be 总长 + u32be 偏移 + 载荷，接收侧重组。
  const DC_CHUNK_MAX = 60 * 1024;
  const DC_FRAME_HEADER = 1 + 4 + 4;
  let chunkSeq = 0;
  const assembling = new Map();

  function dcSendChunked(data) {
    const dc = state.dc;
    if (!dc || dc.readyState !== "open") { return; }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    try {
      if (!bytes || bytes.byteLength <= DC_CHUNK_MAX) {
        const framed = new Uint8Array(1 + bytes.byteLength);
        framed[0] = 0x00;
        framed.set(bytes, 1);
        dc.send(framed);
        return;
      }
      chunkSeq = (chunkSeq + 1) % 0xffffffff;
      const total = bytes.byteLength;
      for (let offset = 0; offset < total; offset += DC_CHUNK_MAX) {
        const size = Math.min(DC_CHUNK_MAX, total - offset);
        const framed = new Uint8Array(DC_FRAME_HEADER + size);
        framed[0] = 0x01;
        new DataView(framed.buffer).setUint32(1, total, false);
        new DataView(framed.buffer).setUint32(5, offset, false);
        framed.set(bytes.subarray(offset, offset + size), DC_FRAME_HEADER);
        dc.send(framed);
      }
    } catch (error) {
      log("dc-send-failed " + String(error).slice(0, 80));
    }
  }

  function dcReceiveChunked(data, deliver) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
    if (!bytes || bytes.byteLength === 0) { return; }
    if (bytes[0] === 0x00) {
      deliver(new Uint8Array(bytes.subarray(1)));
      return;
    }
    if (bytes[0] !== 0x01 || bytes.byteLength <= DC_FRAME_HEADER) { return; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const total = view.getUint32(1, false);
    const offset = view.getUint32(5, false);
    const payload = bytes.subarray(DC_FRAME_HEADER);
    let buf = assembling.get(total);
    if (!buf) {
      buf = { parts: new Map(), received: 0 };
      assembling.set(total, buf);
    }
    if (!buf.parts.has(offset)) {
      buf.parts.set(offset, payload);
      buf.received += payload.byteLength;
    }
    if (buf.received >= total) {
      assembling.delete(total);
      const whole = new Uint8Array(total);
      for (const [partOffset, part] of buf.parts) { whole.set(part, partOffset); }
      deliver(whole);
    }
  }

  function bridgeDataChannel(channel) {
    state.dc = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => { log("dc-open"); emit({ type: "dc-open" }); });
    channel.addEventListener("close", () => {
      // 死亡现场快照：连接/ICE 状态与流量计数，用于定位通道被关的真实原因。
      const pc = state.pc;
      log(
        "dc-closed pc=" + (pc ? pc.connectionState : "null") +
        " ice=" + (pc ? pc.iceConnectionState : "null") +
        " received=" + dcStats.received + " sent=" + dcStats.sent
      );
      assembling.clear();
      emit({ type: "dc-closed" });
    });
    channel.addEventListener("message", (e) => {
      dcStats.received += 1;
      // dc → port：分片重组后投递；Host 侧 MessagePortProtocol 只接受 Uint8Array。
      dcReceiveChunked(e.data, (payload) => { state.port?.postMessage(payload); });
    });
  }

  function handleCommand(command, transferredPort) {
    if (command.type === "negotiate") {
      log("negotiate iceServers=" + JSON.stringify(command.iceServers));
      // iceServers 必须是 [{urls}] 对象数组：直接传字符串数组会 TypeError，
      // 且异常发生在 message 监听器内被静默吞掉——这正是真机 11/11 P2P 静默失败的根因（spec §21.7）。
      const peer = new RTCPeerConnection({
        iceServers: (command.iceServers?.urls ?? []).map((url) => ({ urls: url })),
      });
      state.pc = peer;
      peer.ondatachannel = (e) => bridgeDataChannel(e.channel);
      peer.onicecandidate = (e) => {
        if (e.candidate) {
          emit({ type: "ice", candidate: e.candidate.toJSON() });
        }
      };
      peer.oniceconnectionstatechange = () => {
        log("ice-connection=" + peer.iceConnectionState);
        if (peer.iceConnectionState === "failed") {
          emit({ type: "failed", reason: "ice-failed" });
        }
      };
      peer.onicegatheringstatechange = () => {
        log("ice-gathering=" + peer.iceGatheringState);
      };
      peer.onconnectionstatechange = () => {
        log("connection=" + peer.connectionState);
        if (peer.connectionState === "failed") {
          emit({ type: "failed", reason: "connection-failed" });
        }
      };
      // 桌面是 offerer：自己创建的 DataChannel 必须立即桥接——ondatachannel 只在
      // 应答方触发，发起方丢弃 createDataChannel 返回值会导致 dc-open 永不出现（spec §21.7）。
      const channel = peer.createDataChannel("zrc", { ordered: true });
      bridgeDataChannel(channel);
      peer.createOffer().then((offer) => {
        return peer.setLocalDescription(offer).then(() => {
          const sdp = peer.localDescription.sdp ?? "";
          log("offer sdpBytes=" + sdp.length + " candidates=" + (sdp.match(/a=candidate/g) || []).length);
          emit({ type: "offer", sdp: sdp });
        });
      }).catch((error) => { log("createOffer-failed " + error); emit({ type: "failed", reason: String(error) }); });
      return;
    }
    if (command.type === "answer" && state.pc) {
      log("answer received sdpBytes=" + (command.sdp?.length ?? 0) + " candidates=" + ((command.sdp?.match(/a=candidate/g)) || []).length);
      state.pc.setRemoteDescription({ type: "answer", sdp: command.sdp }).catch((error) => {
        log("setAnswer-failed " + error);
        emit({ type: "failed", reason: String(error) });
      });
      return;
    }
    if (command.type === "ice" && state.pc) {
      state.pc.addIceCandidate(command.candidate).catch(() => {
        // 迟到/失效候选直接忽略（trickle 容错）。
      });
      return;
    }
    if (command.type === "bind-port" && transferredPort) {
      log("bind-port received");
      state.port = transferredPort;
      state.port.onmessage = (e) => {
        dcStats.sent += 1;
        if (dcStats.sent <= 2) { log("dc-msg-out #" + dcStats.sent + " bytes=" + (e.data?.byteLength ?? e.data?.length ?? "?")); }
        dcSendChunked(e.data);
      };
      try { state.port.start(); } catch {}
      return;
    }
    if (command.type === "notify") {
      // 应用层断开通知（spec §21.2）：0x02 控制帧 + JSON；随后由 Main 拆链。
      const dc = state.dc;
      if (dc && dc.readyState === "open") {
        try {
          const payload = new TextEncoder().encode(
            JSON.stringify({ type: "remote-disconnect", reason: command.reason }),
          );
          const framed = new Uint8Array(1 + payload.byteLength);
          framed[0] = 0x02;
          framed.set(payload, 1);
          dc.send(framed);
          log("notify-sent " + command.reason);
        } catch (error) {
          log("notify-failed " + String(error).slice(0, 60));
        }
      }
      return;
    }
    if (command.type === "abort") {
      log("abort");
      try { state.pc?.close(); state.port?.close(); } catch {}
      state.pc = null; state.dc = null; state.port = null;
    }
  }

  // 命令经 window.postMessage 下发：MessagePort 无法过 contextBridge，preload 以
  // postMessage transfer 转移（与 ScopedServicePort 同一模式）。
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.__zcodeRtcCommand !== true) {
      return;
    }
    handleCommand(event.data.command, event.ports[0]);
  });

  // 订阅 Main 命令：preload 收到 ipc 后经 window.postMessage（含端口 transfer）转发到这里。
  // 不订阅则命令永远无法到达（ipcRenderer.on 在 preload 侧按需注册）。
  window.zcode?.onRemoteControlRtcCommand?.(() => {});
  log("glue-ready zcode-bridge=" + (typeof window.zcode?.sendRemoteControlRtcEvent === "function"));
})();
`;

export interface RtcEventHub {
  subscribe(listener: (event: RemoteControlRtcEvent) => void): () => void;
  emit(event: RemoteControlRtcEvent): void;
}

export function createRtcEventHub(): RtcEventHub {
  const listeners = new Set<(event: RemoteControlRtcEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

export function createRtcBrowserWindow(
  preloadPath: string | undefined,
  hub: RtcEventHub,
  logger?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  },
): RtcWindowHandle {
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    // 工具窗口（spec §21.10）：不进任务栏/Dock 窗口列表、不可聚焦、不可被 Exposé 捞出。
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: preloadPath,
      // 隐藏窗口只跑 WebRTC；禁掉其余能力面。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // macOS：从 Mission Control / App Exposé / Dock 窗口列表中隐藏（Electron ≥ 25）。
  // 该 API 要求窗口 ready 后调用才稳定生效，ready-to-show 再补一次。
  win.setHiddenInMissionControl(true);
  win.once("ready-to-show", () => {
    try {
      win.setHiddenInMissionControl(true);
    } catch {
      // 窗口可能已被销毁。
    }
  });
  // 用户从 Mission Control/窗口列表手动关闭本窗口时，合成 dc-closed 让控制器
  // 拆除 p2p attachment 并通知 service 转 waiting——否则残留 p2pActive 会永久
  // 拒绝后续协商（2026-09-24 真机：手动关窗后回不到直连）。
  win.on("closed", () => {
    // 仅用户主动关闭（destroyed 仍为 false）时合成事件；控制器正常 teardown 已置位。
    if (!destroyed) {
      destroyed = true;
      pendingCommands.length = 0;
      hub.emit({ type: "dc-closed" });
    }
  });
  let destroyed = false;
  // 命令竞态修复：窗口 loadURL → executeJavaScript(胶水) 完成前，preload 的命令订阅
  // 尚未注册（P1-2 按需订阅），此刻 postMessage 的命令会被渲染进程静默丢弃——
  // 真机上 11/11 的 signal-budget-exceeded 均源于 negotiate 在胶水就绪前投递（spec §21.7）。
  // 这里在 Main 侧缓冲命令，收到胶水的 glue-ready 信号后再 flush。
  let glueReady = false;
  const pendingCommands: Array<{
    command: RemoteControlRtcCommand;
    transfer?: Electron.MessagePortMain[];
  }> = [];
  const flushPendingCommands = (): void => {
    for (const item of pendingCommands.splice(0)) {
      win.webContents.postMessage(
        PlatformChannels.RemoteControlRtcCommand,
        item.command,
        item.transfer ?? [],
      );
    }
  };

  // 隐藏窗口的 console（胶水诊断日志）转发进 Main 日志：P2P 失败排查的唯一窗口内观测面。
  win.webContents.on("console-message", (_event, level, message) => {
    if (message.includes("[rtc-glue] glue-ready")) {
      glueReady = true;
      flushPendingCommands();
    }
    if (message.startsWith("[rtc-glue]")) {
      logger?.info(`[remote-control-rtc-window] ${message}`);
      return;
    }
    // 错误级（含未捕获异常）一并转发：注入失败时唯一线索。
    if (level >= 3) {
      logger?.warn("[remote-control-rtc-window:console-error]", { message });
    }
  });

  // about:blank 即可：胶水脚本经 executeJavaScript 注入，不加载应用页面。
  // 每步落日志 + 失败一次重试：注入链路任何一环静默失败都会表现为 budget 超时，无凭据可查。
  const injectGlue = (attempt: number): void => {
    if (destroyed) {
      return;
    }
    void win.webContents
      .executeJavaScript(RTC_GLUE_SCRIPT, true)
      .then(() => {
        logger?.info("[remote-control-rtc-window] glue injected", { attempt });
      })
      .catch((error: unknown) => {
        logger?.warn("[remote-control-rtc-window] glue inject failed", {
          attempt,
          error: String(error),
        });
        if (attempt === 1) {
          setTimeout(() => injectGlue(2), 500);
        }
      });
  };
  void win
    .loadURL("about:blank")
    .then(() => {
      logger?.info("[remote-control-rtc-window] about:blank loaded");
      if (!destroyed) {
        injectGlue(1);
      }
    })
    .catch((error: unknown) => {
      logger?.warn("[remote-control-rtc-window] loadURL failed", { error: String(error) });
    });

  return {
    sendCommand(command: RemoteControlRtcCommand, transfer?: Electron.MessagePortMain[]): void {
      if (destroyed) {
        return;
      }
      if (!glueReady) {
        pendingCommands.push({ command, transfer });
        return;
      }
      win.webContents.postMessage(
        PlatformChannels.RemoteControlRtcCommand,
        command,
        transfer ?? [],
      );
    },
    onEvent(listener: (event: RemoteControlRtcEvent) => void): () => void {
      return hub.subscribe(listener);
    },
    destroy(): void {
      destroyed = true;
      pendingCommands.length = 0;
      try {
        win.destroy();
      } catch {
        // 窗口可能已销毁。
      }
    },
  };
}
