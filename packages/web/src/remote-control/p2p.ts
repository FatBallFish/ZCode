import { MessagePortProtocol, type MessagePortLike } from "@zcode/rpc";
import type { RemoteControlRtcSignal } from "@zcode/shared/remote-control";

/**
 * 手机端 P2P 协商（spec §9.2/§9.3）：经 relay 信令管道交换 offer/answer/ICE，
 * DataChannel 打通后以 MessagePortProtocol 语义直连（消息边界、无 13B 帧头）。
 *
 * 切换语义：P2P 建立 = 一次受控重连——成功后才关闭中转数据管道（close code 4005）；
 * 任一环节失败即整体放弃，保持中转。
 */

const SIGNAL_BUDGET_MS = 15_000;

/**
 * 大消息分片（spec §21.9，与桌面 rtcWindow 胶水对称）：DataChannel 单消息受 SCTP 协商
 * 上限约束，快照类大消息直接 send 会打死通道。帧格式：0x00 裸小消息；0x01 分片
 * （u32be 总长 + u32be 偏移 + 载荷），接收侧按总长重组。
 */
const DC_CHUNK_MAX = 60 * 1024;
const DC_FRAME_HEADER = 1 + 4 + 4;

function dcSendChunked(dc: RTCDataChannel, data: unknown): void {
  if (dc.readyState !== "open") {
    return;
  }
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array | undefined);
  if (!bytes) {
    return;
  }
  try {
    if (bytes.byteLength <= DC_CHUNK_MAX) {
      const framed = new Uint8Array(1 + bytes.byteLength);
      framed[0] = 0x00;
      framed.set(bytes, 1);
      dc.send(framed);
      return;
    }
    const total = bytes.byteLength;
    for (let offset = 0; offset < total; offset += DC_CHUNK_MAX) {
      const size = Math.min(DC_CHUNK_MAX, total - offset);
      const framed = new Uint8Array(DC_FRAME_HEADER + size);
      framed[0] = 0x01;
      const view = new DataView(framed.buffer);
      view.setUint32(1, total, false);
      view.setUint32(5, offset, false);
      framed.set(bytes.subarray(offset, offset + size), DC_FRAME_HEADER);
      dc.send(framed);
    }
  } catch {
    // 发送失败（超限/通道半开）由 dc close/failed 事件驱动回退，这里不重复处理。
  }
}

function createChunkAssembler(
  deliver: (payload: Uint8Array) => void,
  onControl?: (message: { type?: string; reason?: string }) => void,
): (data: ArrayBuffer | Uint8Array) => void {
  const assembling = new Map<number, { parts: Map<number, Uint8Array>; received: number }>();
  return (data) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!bytes || bytes.byteLength === 0) {
      return;
    }
    if (bytes[0] === 0x00) {
      deliver(new Uint8Array(bytes.subarray(1)));
      return;
    }
    if (bytes[0] === 0x02) {
      // 应用层控制帧（spec §21.2）：桌面拆链前主动通知，秒级感知断开/被顶替。
      try {
        onControl?.(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
      } catch {
        // 非法控制帧忽略。
      }
      return;
    }
    if (bytes[0] !== 0x01 || bytes.byteLength <= DC_FRAME_HEADER) {
      return;
    }
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
      for (const [partOffset, part] of buf.parts) {
        whole.set(part, partOffset);
      }
      deliver(whole);
    }
  };
}

/** DataChannel → MessagePortLike：分片重组后投递；发送侧分片（MessagePortProtocol 只认 Uint8Array）。 */
function dataChannelAsPort(
  dc: RTCDataChannel,
  onControl?: (message: { type?: string; reason?: string }) => void,
): MessagePortLike {
  const handlers = new Set<(e: { data: import("@zcode/rpc").MessagePortPayload }) => void>();
  dc.binaryType = "arraybuffer";
  const assemble = createChunkAssembler((payload) => {
    for (const handler of handlers) {
      handler({ data: payload as import("@zcode/rpc").MessagePortPayload });
    }
  }, onControl);
  dc.addEventListener("message", (event) => {
    assemble(event.data as ArrayBuffer);
  });
  dc.addEventListener("close", () => {
    /* 分片缓冲随通道丢弃；未完成消息由 RPC 层重传语义兜底。 */
  });
  return {
    addEventListener(
      _type: "message",
      listener: (e: { data: import("@zcode/rpc").MessagePortPayload }) => void,
    ) {
      handlers.add(listener);
    },
    removeEventListener(
      _type: "message",
      listener: (e: { data: import("@zcode/rpc").MessagePortPayload }) => void,
    ) {
      handlers.delete(listener);
    },
    postMessage(message: unknown) {
      dcSendChunked(dc, message);
    },
    start() {},
    close() {
      dc.close();
    },
  };
}

export interface P2pNegotiation {
  /** DataChannel 已打通并完成协议装配；调用方切换数据源后应关闭中转管道（code 4005）。 */
  readonly protocol: MessagePortProtocol;
  /** dc 断开/连接载体失败时回调（spec §9.4 回退触发器；dispose 后不再回调）。 */
  onDisconnected(listener: () => void): void;
  /** 桌面经 0x02 控制帧主动断开（spec §21.2）：reason 对应终态屏，无需等 ICE 超时。 */
  onRemoteDisconnected(listener: (reason: "desktop-disconnected" | "superseded") => void): void;
  /** 主动放弃/回退（dc 断开、协商失败、调用方 dispose）。 */
  dispose(): void;
}

/**
 * 发起 P2P 协商。resolve 于协商成功（P2P_PROMOTED 关中转由调用方执行）；
 * 协商失败/超时 resolve 为 null（保持中转，静默降级）。
 */
export function negotiateP2p(options: {
  relayWsBase: string;
  sid: string;
  token: string;
  logger?: { warn(message: string): void };
}): Promise<P2pNegotiation | null> {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === "undefined") {
      resolve(null);
      return;
    }
    let settled = false;
    let disposed = false;
    const disconnectListeners = new Set<() => void>();
    const remoteDisconnectListeners = new Set<
      (reason: "desktop-disconnected" | "superseded") => void
    >();
    let pc: RTCPeerConnection | null = null;
    let dc: RTCDataChannel | null = null;
    let signal: WebSocket | null = null;

    const notifyDisconnected = (): void => {
      if (disposed) {
        return;
      }
      for (const listener of disconnectListeners) {
        listener();
      }
    };

    const finish = (result: P2pNegotiation | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(budget);
      if (!result) {
        try {
          pc?.close();
        } catch {
          // 已关闭。
        }
        signal?.close();
      }
      resolve(result);
    };

    const send = (data: RemoteControlRtcSignal): void => {
      if (signal?.readyState === WebSocket.OPEN) {
        signal.send(JSON.stringify(data));
      }
    };

    const budget = setTimeout(() => finish(null), SIGNAL_BUDGET_MS);

    const handleSignal = (data: RemoteControlRtcSignal): void => {
      if (data.kind === "config") {
        pc = new RTCPeerConnection({
          iceServers: data.iceServers.urls.map((url) => ({ urls: url })),
        });
        pc.ondatachannel = (event) => {
          dc = event.channel;
          dc.binaryType = "arraybuffer";
          dc.addEventListener("open", () => {
            if (!dc) {
              finish(null);
              return;
            }
            const negotiation: P2pNegotiation = {
              protocol: new MessagePortProtocol(
                dataChannelAsPort(dc, (message) => {
                  if (message?.type === "remote-disconnect" && message.reason) {
                    const reason =
                      message.reason === "superseded" ? "superseded" : "desktop-disconnected";
                    // 到达即终态：立刻上抛并整体收尾（spec §21.2，不等 ICE 超时/回退重连）。
                    settled = true;
                    clearTimeout(budget);
                    for (const listener of remoteDisconnectListeners) {
                      listener(reason);
                    }
                    try {
                      dc?.close();
                      pc?.close();
                    } catch {
                      // 已关闭。
                    }
                    signal?.close();
                  }
                }),
              ),
              onDisconnected(listener) {
                disconnectListeners.add(listener);
              },
              onRemoteDisconnected(listener) {
                remoteDisconnectListeners.add(listener);
              },
              dispose() {
                disposed = true;
                disconnectListeners.clear();
                try {
                  dc?.close();
                  pc?.close();
                } catch {
                  // 已关闭。
                }
                signal?.close();
              },
            };
            finish(negotiation);
          });
          dc.addEventListener("close", () => {
            signal?.close();
            notifyDisconnected();
          });
        };
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            send({
              kind: "ice",
              candidate: event.candidate.toJSON() as unknown as Record<string, unknown>,
            });
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc?.connectionState === "failed") {
            // 已升级后失败走回退通知；协商期失败按放弃处理。
            if (settled) {
              notifyDisconnected();
            } else {
              finish(null);
            }
          }
        };
        send({ kind: "p2p_request" });
        return;
      }
      if (data.kind === "offer" && pc) {
        void pc
          .setRemoteDescription({ type: "offer", sdp: data.sdp })
          .then(() => pc!.createAnswer())
          .then((answer) => pc!.setLocalDescription(answer))
          .then(() => {
            send({ kind: "answer", sdp: pc!.localDescription?.sdp ?? "" });
          })
          .catch(() => finish(null));
        return;
      }
      if (data.kind === "ice" && pc) {
        void pc.addIceCandidate(data.candidate as unknown as RTCIceCandidateInit).catch(() => {
          // 迟到/失效候选忽略。
        });
        return;
      }
      if (data.kind === "reject") {
        finish(null);
      }
    };

    // relay 在连接建立瞬间即下发 config，可能与 open 同一 TCP 段到达：
    // 从构造起就挂 onmessage，避免注册晚于首帧。
    signal = new WebSocket(
      `${options.relayWsBase}/ws/signal?sid=${encodeURIComponent(options.sid)}&token=${encodeURIComponent(options.token)}`,
    );
    signal.onmessage = (event) => {
      try {
        handleSignal(JSON.parse(String(event.data)) as RemoteControlRtcSignal);
      } catch {
        // 非 JSON 帧忽略。
      }
    };
    signal.onclose = () => {
      if (!settled && dc?.readyState !== "open") {
        finish(null);
      }
    };
    signal.onerror = () => {
      finish(null);
    };
  });
}
