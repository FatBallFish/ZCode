import { HEADER_SIZE, ProtocolMessageType, VSBuffer } from "@zcode/rpc";

/**
 * 手机流泵（spec §7.3）：手机管道与窗口 Host attachment 之间的分帧翻译器。
 *
 * 两侧传输语义不同，不能当字节管道：
 *   手机侧 = SocketProtocol over WS：每条 binary 消息 = 13 字节帧头 + 载荷；
 *   Host 侧 = MessagePortProtocol：每条消息 = 载荷本体（Uint8Array），无帧头。
 * 因此逐消息做「剥/补帧头」翻译；type 固定 Regular、id/ack 置 0（非 persistent 链路）。
 */

/** MessagePortMain 的最小子集；测试里用 worker_threads MessagePort 同构实现。 */
export interface PumpPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
}

export interface MobileStreamPump {
  /** 手机 → Host：输入 WS binary（含 13 字节帧头）。格式非法返回 false（调用方应断管道）。 */
  handleWireBytes(bytes: Uint8Array): boolean;
  dispose(): void;
}

export function createMobileStreamPump(options: {
  port: PumpPort;
  /** Host → 手机：输出补好帧头的完整 WS binary（不含 relay streamId 前缀）。 */
  sendWireBytes(bytes: Uint8Array): void;
  /** Host 侧端口关闭（含 scope 校验失败 fail-closed）→ 上报 relay 断开手机管道。 */
  notifyClosed(reason: string): void;
  onInvalidFrame?(reason: string): void;
}): MobileStreamPump {
  const { port } = options;
  let disposed = false;

  port.start?.();
  port.on("message", (event: { data: unknown }) => {
    if (disposed) {
      return;
    }
    const data = event.data;
    // Host 侧 MessagePortProtocol.send 以 ArrayBuffer 下发；worker/测试路径可能直接给 Uint8Array。
    let payload: Uint8Array | null = null;
    if (data instanceof Uint8Array) {
      payload = data;
    } else if (data instanceof ArrayBuffer) {
      payload = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
      payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      // 协议级流控对象（connection-flow-v1）与未知控制对象一律丢弃：手机链路不启用协议级流控。
      return;
    }
    const header = new Uint8Array(HEADER_SIZE);
    header[0] = ProtocolMessageType.Regular;
    new DataView(header.buffer).setUint32(1, 0, false);
    new DataView(header.buffer).setUint32(5, 0, false);
    new DataView(header.buffer).setUint32(9, payload.byteLength, false);
    const framed = new Uint8Array(HEADER_SIZE + payload.byteLength);
    framed.set(header, 0);
    framed.set(payload, HEADER_SIZE);
    options.sendWireBytes(framed);
  });

  port.on("close", () => {
    if (!disposed) {
      options.notifyClosed("host-port-closed");
    }
  });

  return {
    handleWireBytes(bytes: Uint8Array): boolean {
      if (disposed) {
        return false;
      }
      if (bytes.byteLength < HEADER_SIZE) {
        options.onInvalidFrame?.("short-frame");
        return false;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const type = bytes[0] ?? 0;
      const length = view.getUint32(9, false);
      if (type !== ProtocolMessageType.Regular) {
        options.onInvalidFrame?.("non-regular-frame");
        return false;
      }
      if (HEADER_SIZE + length !== bytes.byteLength) {
        options.onInvalidFrame?.("length-mismatch");
        return false;
      }
      // 必须以 Uint8Array 视图 post：Host 侧 MessagePortProtocol 只接受 instanceof Uint8Array。
      const payload = bytes.subarray(HEADER_SIZE);
      port.postMessage(new Uint8Array(payload));
      return true;
    },
    dispose() {
      disposed = true;
      try {
        port.close();
      } catch {
        // 端口可能已被 Host 关闭；dispose 幂等。
      }
    },
  };
}

/** 供测试/调试断言使用：与泵输出一致的帧编码（13B Regular 帧头 + 载荷）。 */
export function encodeRegularFrame(payload: Uint8Array): VSBuffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(ProtocolMessageType.Regular, 0);
  header.writeUInt32BE(0, 1);
  header.writeUInt32BE(0, 5);
  header.writeUInt32BE(payload.byteLength, 9);
  const framed = new Uint8Array(HEADER_SIZE + payload.byteLength);
  framed.set(header, 0);
  framed.set(payload, HEADER_SIZE);
  return VSBuffer.wrap(framed);
}
