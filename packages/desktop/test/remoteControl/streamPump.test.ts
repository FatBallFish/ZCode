import assert from "node:assert/strict";
import test from "node:test";
import { HEADER_SIZE, ProtocolMessageType } from "@zcode/rpc";
import { createMobileStreamPump, type PumpPort } from "../../src/main/remoteControl/streamPump.js";

/** 内存 port：on("message") 是泵收 Host 消息的通道；postMessage 是发往 Host 的通道。 */
function createPortPair() {
  let pumpMessageListener: ((event: { data: unknown }) => void) | null = null;
  let pumpCloseListener: (() => void) | null = null;
  const hostReceived: unknown[] = [];
  const port: PumpPort = {
    on(event: "message" | "close", listener: never) {
      if (event === "message") {
        pumpMessageListener = listener as (event: { data: unknown }) => void;
      } else {
        pumpCloseListener = listener as () => void;
      }
      return undefined;
    },
    postMessage(message) {
      queueMicrotask(() => hostReceived.push(message));
    },
    close() {
      queueMicrotask(() => pumpCloseListener?.());
    },
  };
  return {
    port,
    hostReceived,
    emitFromHost: (data: unknown) => {
      queueMicrotask(() => pumpMessageListener?.({ data }));
    },
    emitClose: () => pumpCloseListener?.(),
  };
}

function frameRegular(
  payload: Uint8Array,
  type = ProtocolMessageType.Regular,
  declaredLength?: number,
): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  frame[0] = type;
  const view = new DataView(frame.buffer);
  view.setUint32(1, 0, false);
  view.setUint32(5, 0, false);
  view.setUint32(9, declaredLength ?? payload.byteLength, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

test("泵下行：手机帧剥 13 字节帧头后以 Uint8Array 投给 Host", async () => {
  const pair = createPortPair();
  const outbound: Uint8Array[] = [];
  const closed: string[] = [];
  const pump = createMobileStreamPump({
    port: pair.port,
    sendWireBytes: (bytes) => outbound.push(bytes),
    notifyClosed: (reason) => closed.push(reason),
  });
  const payload = new TextEncoder().encode("hello-host");
  assert.equal(pump.handleWireBytes(frameRegular(payload)), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pair.hostReceived.length, 1);
  const delivered = pair.hostReceived[0];
  assert.ok(delivered instanceof Uint8Array, "必须是 Uint8Array（Host 侧 instanceof 校验）");
  assert.deepEqual(delivered, payload);
  assert.equal(outbound.length, 0);
  assert.equal(closed.length, 0);
});

test("泵上行：Host 消息（ArrayBuffer/Uint8Array）补 Regular 帧头后发出", async () => {
  const pair = createPortPair();
  const outbound: Uint8Array[] = [];
  const pump = createMobileStreamPump({
    port: pair.port,
    sendWireBytes: (bytes) => outbound.push(bytes),
    notifyClosed: () => {},
  });
  const payload = new TextEncoder().encode("hello-phone");
  pair.emitFromHost(payload.buffer); // Host 侧 MessagePortProtocol.send 发的是 ArrayBuffer。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(outbound.length, 1);
  const framed = outbound[0]!;
  assert.equal(framed[0], ProtocolMessageType.Regular);
  assert.equal(
    new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(9, false),
    payload.byteLength,
  );
  assert.deepEqual(framed.subarray(HEADER_SIZE), payload);
  // 回环验证：泵发出的帧能被自己的 handleWireBytes 剥回原载荷。
  pair.hostReceived.length = 0;
  assert.equal(pump.handleWireBytes(framed), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(pair.hostReceived[0], payload);
});

test("流控对象被丢弃且不发帧", async () => {
  const pair = createPortPair();
  const outbound: Uint8Array[] = [];
  createMobileStreamPump({
    port: pair.port,
    sendWireBytes: (bytes) => outbound.push(bytes),
    notifyClosed: () => {},
  });
  pair.emitFromHost({ __zcodeRpcControl: "connection-flow-v1", state: "saturated" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(outbound.length, 0);
});

test("非法帧：短帧 / 非 Regular / 长度不匹配全部拒绝", () => {
  const pair = createPortPair();
  const invalid: string[] = [];
  const pump = createMobileStreamPump({
    port: pair.port,
    sendWireBytes: () => {},
    notifyClosed: () => {},
    onInvalidFrame: (reason) => invalid.push(reason),
  });
  assert.equal(pump.handleWireBytes(new Uint8Array(5)), false);
  const payload = new TextEncoder().encode("x");
  assert.equal(pump.handleWireBytes(frameRegular(payload, ProtocolMessageType.KeepAlive)), false);
  assert.equal(
    pump.handleWireBytes(frameRegular(payload, ProtocolMessageType.Regular, 999)),
    false,
  );
  assert.deepEqual(invalid, ["short-frame", "non-regular-frame", "length-mismatch"]);
  // Host 侧不应收到任何消息。
  assert.equal(pair.hostReceived.length, 0);
});

test("Host 端口关闭触发 notifyClosed；dispose 幂等", () => {
  const pair = createPortPair();
  const closed: string[] = [];
  const pump = createMobileStreamPump({
    port: pair.port,
    sendWireBytes: () => {},
    notifyClosed: (reason) => closed.push(reason),
  });
  pair.emitClose();
  assert.deepEqual(closed, ["host-port-closed"]);
  pump.dispose();
  pump.dispose();
  // dispose 后不再处理任何输入。
  assert.equal(pump.handleWireBytes(frameRegular(new Uint8Array(1))), false);
});
