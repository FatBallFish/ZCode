import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRemoteControlDesktopFrame,
  parseRemoteControlDesktopFrameTolerant,
  parseRemoteControlRtcSignalTolerant,
} from "@zcode/shared/remote-control";

/**
 * 前向兼容宽容解析（spec §22）：新客户端 + 旧 relay 场景由 relay 剥未知字段兜底；
 * 桌面自用 parseRemoteControlDesktopFrame 保持 strict（客户端只面对同版本协议）。
 */

test("宽容解析：桌面控制帧的未知顶层字段被剥除而非整帧判非法", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "issue_session",
    persistent: true,
    futureField: { nested: true },
  });
  const strict = parseRemoteControlDesktopFrame(raw);
  assert.equal(strict, null, "strict 解析应拒绝未知字段（客户端侧行为不变）");
  const tolerant = parseRemoteControlDesktopFrameTolerant(raw);
  assert.ok(tolerant && tolerant.type === "issue_session");
  assert.equal(tolerant.persistent, true, "已知字段保留");
});

test("宽容解析：帧内类型/值仍须合法（v 错误仍拒绝）", () => {
  const raw = JSON.stringify({ v: 2, type: "issue_session", extra: 1 });
  assert.equal(parseRemoteControlDesktopFrameTolerant(raw), null);
});

test("宽容解析：手机信令未知字段被剥除", () => {
  const raw = JSON.stringify({ kind: "p2p_request", futureField: 1 });
  const parsed = parseRemoteControlRtcSignalTolerant(raw);
  assert.ok(parsed && parsed.kind === "p2p_request");
});

test("宽容解析：config.iceServers 的未知子字段被剥除", () => {
  const raw = JSON.stringify({
    kind: "config",
    iceServers: { urls: ["stun:x:1"], future: true },
    futureTop: 1,
  });
  const parsed = parseRemoteControlRtcSignalTolerant(raw);
  assert.ok(parsed && parsed.kind === "config");
  assert.deepEqual(parsed.iceServers.urls, ["stun:x:1"]);
});

test("宽容解析：非法 JSON / 非对象输入返回 null", () => {
  assert.equal(parseRemoteControlDesktopFrameTolerant("not-json"), null);
  assert.equal(parseRemoteControlDesktopFrameTolerant("[1,2]"), null);
  assert.equal(parseRemoteControlRtcSignalTolerant("null"), null);
});
