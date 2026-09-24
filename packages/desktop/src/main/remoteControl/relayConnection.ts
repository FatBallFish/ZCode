import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  decodeRemoteControlDataFrame,
  encodeRemoteControlDataFrame,
  parseRemoteControlDesktopFrame,
  type RemoteControlDesktopFrame,
  type RemoteControlRtcSignal,
} from "@zcode/shared/remote-control";

/**
 * 桌面 ↔ relay 单连接封装（spec §6.3 帧协议）。
 *
 * 传输层经工厂注入（生产用 ws 包，测试可注入内存实现）；
 * handlers 在建立连接前注册，避免 open 与首帧同段到达的竞态（relay 的 config 注入同理）。
 */

export interface RelayTransport {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RelayTransportHandlers {
  onOpen(): void;
  onText(text: string): void;
  onBinary(data: Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(error: Error): void;
}

export type RelayTransportFactory = (
  url: string,
  handlers: RelayTransportHandlers,
) => RelayTransport;

export interface RelayConnectionEvents {
  /** 控制帧（已通过 zod 校验）。 */
  onFrame(frame: RemoteControlDesktopFrame): void;
  /** 数据帧（已剥 streamId 前缀，载荷为完整 SocketProtocol 帧）。 */
  onBinary(streamId: number, payload: Uint8Array): void;
  /** 连接断开（含被拒绝）。 */
  onClosed(code: number, reason: string): void;
}

export class RelayConnection {
  private transport: RelayTransport | null = null;
  private closedByUs = false;
  private closedEmitted = false;

  constructor(
    private readonly url: string,
    private readonly transportFactory: RelayTransportFactory,
    private readonly events: RelayConnectionEvents,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.closedEmitted = false;
    this.transport = this.transportFactory(this.url, {
      onOpen: () => {
        // register_ok 由 onFrame 透传；此处无需额外动作。
      },
      onText: (text) => {
        const frame = parseRemoteControlDesktopFrame(text);
        if (!frame) {
          this.events.onClosed(1002, "invalid-control-frame");
          this.transport?.close(1002, "invalid-control-frame");
          return;
        }
        this.events.onFrame(frame);
      },
      onBinary: (data) => {
        const decoded = decodeRemoteControlDataFrame(data);
        if (!decoded) {
          this.events.onClosed(1002, "invalid-data-frame");
          this.transport?.close(1002, "invalid-data-frame");
          return;
        }
        this.events.onBinary(decoded.streamId, decoded.payload);
      },
      onClose: (code, reason) => {
        this.transport = null;
        if (this.closedByUs || this.closedEmitted) {
          return;
        }
        // error 后必跟 close：latch 保证 onClosed 只发一次，避免上层退避被双重驱动。
        this.closedEmitted = true;
        this.events.onClosed(code, reason);
      },
      onError: (error) => {
        this.transport = null;
        if (this.closedByUs || this.closedEmitted) {
          return;
        }
        this.closedEmitted = true;
        this.events.onClosed(1006, error.message);
      },
    });
  }

  private send(frame: RemoteControlDesktopFrame): void {
    this.transport?.sendText(JSON.stringify(frame));
  }

  sendRegister(input: { mid: string; token: string; name: string; appVersion: string }): void {
    this.send({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "register", ...input });
  }

  sendIssueSession(options?: { persistent?: boolean }): void {
    this.send({
      v: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "issue_session",
      ...(options?.persistent === true ? { persistent: true } : {}),
    });
  }

  sendRevokeSession(sid: string): void {
    this.send({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "revoke_session", sid });
  }

  sendDisconnectSession(sid: string): void {
    this.send({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "disconnect_session", sid });
  }

  sendStreamAccepted(streamId: number): void {
    this.send({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "stream_accepted", streamId });
  }

  sendStreamCloseNotify(streamId: number): void {
    this.send({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "stream_close_notify", streamId });
  }

  sendRtcSignal(streamId: number, data: RemoteControlRtcSignal): void {
    this.send({ v: REMOTE_CONTROL_PROTOCOL_VERSION, type: "rtc_signal", streamId, data });
  }

  /** 发送手机管道数据：streamId 前缀 + 完整 SocketProtocol 帧（泵已补帧头）。 */
  sendStreamBinary(streamId: number, framedPayload: Uint8Array): void {
    this.transport?.sendBinary(encodeRemoteControlDataFrame(streamId, framedPayload));
  }

  close(): void {
    this.closedByUs = true;
    this.transport?.close();
    this.transport = null;
  }
}

/** 生产传输工厂：Node ws 客户端。open 前缓冲发送（register 在连接建立瞬间即发出）。 */
export function createWsTransportFactory(
  WebSocketCtor: new (url: string) => {
    on(event: string, listener: (...args: never[]) => void): unknown;
    send(data: string | Uint8Array, options?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
  },
): RelayTransportFactory {
  return (url, handlers) => {
    const ws = new WebSocketCtor(url);
    let open = false;
    let closed = false;
    const pendingSends: Array<() => void> = [];
    const trySend = (perform: () => void): void => {
      if (open) {
        perform();
        return;
      }
      if (closed) {
        return;
      }
      pendingSends.push(perform);
    };
    ws.on("open", () => {
      open = true;
      for (const send of pendingSends.splice(0)) {
        send();
      }
      handlers.onOpen();
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        handlers.onBinary(new Uint8Array(data));
      } else {
        handlers.onText(data.toString("utf8"));
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      closed = true;
      pendingSends.length = 0;
      handlers.onClose(code, reason?.toString("utf8") ?? "");
    });
    ws.on("error", (error: Error) => {
      closed = true;
      pendingSends.length = 0;
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return {
      sendText: (text) => trySend(() => ws.send(text)),
      sendBinary: (data) => trySend(() => ws.send(data, { binary: true })),
      close: (code, reason) => {
        closed = true;
        pendingSends.length = 0;
        ws.close(code, reason);
      },
    };
  };
}
