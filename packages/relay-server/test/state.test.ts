import assert from "node:assert/strict";
import test from "node:test";
import { RelayState } from "../src/state.js";
import { REMOTE_CONTROL_TICKET_TTL_MS } from "@zcode/shared/remote-control";
import { computeAccessHash } from "../src/tickets.js";

const SECRET = "test-secret";
const MID = "mid-a";

/** 可控时钟的 state 工厂。 */
function fixture() {
  let now = 1_000_000;
  const clock = () => now;
  return {
    state: new RelayState(SECRET, clock),
    advance(ms: number) {
      now += ms;
    },
    setNow(next: number) {
      now = next;
    },
    get now() {
      return now;
    },
  };
}

function issueAndBind(state: RelayState, t: number, mid = MID, secret = SECRET) {
  const issued = state.issueSession(mid);
  return {
    issued,
    bind: state.bindTicket({
      sid: issued.sid,
      hash: computeAccessHash(secret, issued.sid, mid, t),
      t,
      mid,
    }),
  };
}

test("票据：可多次 bind，每次重铸 token（spec §21.1）", () => {
  const { state, now } = fixture();
  const { issued, bind } = issueAndBind(state, now);
  assert.ok(bind.ok);
  const secondBind = state.bindTicket({
    sid: issued.sid,
    hash: computeAccessHash(SECRET, issued.sid, MID, now),
    t: now,
    mid: MID,
  });
  assert.ok(secondBind.ok);
  assert.notEqual(secondBind.sessionToken, bind.sessionToken, "第二次 bind 必须重铸 token");
  // 旧 token 立即失效（checkPhoneUpgrade 只认最新 token）。
  assert.ok(!state.checkPhoneUpgrade(issued.sid, bind.sessionToken).ok);
  assert.ok(state.checkPhoneUpgrade(issued.sid, secondBind.sessionToken).ok);
});

test("长效票据：无 TTL，sweep 不过期，可跨期多次 bind（spec §21.1）", () => {
  const { state, advance } = fixture();
  const issued = state.issueSession(MID, { persistent: true });
  advance(24 * 60 * 60_000);
  state.sweep();
  assert.equal(state.sessions.get(issued.sid)?.state, "pending", "长效票据永不被 sweep 过期");
  const hash = computeAccessHash(SECRET, issued.sid, MID, issued.issuedAt, true);
  const bind = state.bindTicket({ sid: issued.sid, hash, t: issued.issuedAt, mid: MID });
  assert.ok(bind.ok);
  // 长效与短时前缀不可互通：短时签名验不过长效票据。
  const shortHash = computeAccessHash(SECRET, issued.sid, MID, issued.issuedAt, false);
  assert.ok(
    !state.bindTicket({ sid: issued.sid, hash: shortHash, t: issued.issuedAt, mid: MID }).ok,
    "短时前缀签名不能通过长效票据校验",
  );
});

test("票据：TTL 过期拒绝且会话作废", () => {
  const { state, now, advance } = fixture();
  const { issued } = { issued: state.issueSession(MID) };
  advance(10 * 60_000 + 1);
  const result = state.bindTicket({
    sid: issued.sid,
    hash: computeAccessHash(SECRET, issued.sid, MID, now),
    t: now,
    mid: MID,
  });
  assert.ok(!result.ok);
  assert.equal(state.sessions.get(issued.sid)?.state, "closed");
});

test("票据：签名不符拒绝", () => {
  const { state, now } = fixture();
  const issued = state.issueSession(MID);
  const result = state.bindTicket({
    sid: issued.sid,
    hash: computeAccessHash("wrong-secret", issued.sid, MID, now),
    t: now,
    mid: MID,
  });
  assert.ok(!result.ok);
  // 签名失败不消费票据（仍可凭正确签名 bind）。
  const okBind = state.bindTicket({
    sid: issued.sid,
    hash: computeAccessHash(SECRET, issued.sid, MID, now),
    t: now,
    mid: MID,
  });
  assert.ok(okBind.ok);
});

test("会话凭证：checkPhoneUpgrade 按 token 与状态裁决", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  const { bind } = issueAndBind(state, Date.now());
  assert.ok(bind.ok);
  const sid = [...state.sessions.keys()][0]!;
  const token = bind.sessionToken;

  assert.ok(state.checkPhoneUpgrade(sid, token).ok);
  assert.ok(!state.checkPhoneUpgrade(sid, "wrong-token").ok);
  assert.ok(!state.checkPhoneUpgrade("s_missing", token).ok);

  // closed 后拒绝。
  const session = state.sessions.get(sid)!;
  session.state = "closed";
  assert.ok(!state.checkPhoneUpgrade(sid, token).ok);
});

test("绑定流：首连分配 streamId 并通知桌面", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  const { issued, bind } = issueAndBind(state, Date.now());
  assert.ok(bind.ok);
  state.desktopRoutes.set(MID, { nextStreamId: 0 });

  const { effects, streamId } = state.bindPhoneStream(MID, issued.sid);
  assert.equal(streamId, 0);
  assert.deepEqual(
    effects.map((effect) => effect.kind),
    ["stream_open"],
  );
  assert.equal(state.sessions.get(issued.sid)?.state, "bound");
  assert.equal(state.desktopRoutes.get(MID)?.activeStream?.sid, issued.sid);
  assert.equal(state.desktopRoutes.get(MID)?.nextStreamId, 1);
});

test("踢人：新 sid 绑定踢掉旧 sid（含 grace 中的）", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const first = issueAndBind(state, Date.now());
  const second = issueAndBind(state, Date.now());
  assert.ok(first.bind.ok && second.bind.ok);

  const firstBind = state.bindPhoneStream(MID, first.issued.sid);
  assert.ok(firstBind.streamId >= 0);
  // 手机 A 断开 → grace。
  state.phoneDisconnected(first.issued.sid);
  assert.equal(state.sessions.get(first.issued.sid)?.state, "grace");

  // 手机 B 绑定：踢 A（grace 中也算「前连」，只剩信令管道可关），A 会话作废。
  // 手机 B 绑定：踢 A（grace 中也算「前连」）；即使无活跃中转流，也按会话保留的
  // streamId 补发 stream_close(kicked) 让桌面拆残留状态（spec §21.9）。
  const secondBind = state.bindPhoneStream(MID, second.issued.sid);
  assert.deepEqual(
    secondBind.effects.map((effect) => effect.kind),
    ["close_phone", "stream_close", "stream_open"],
  );
  assert.equal(state.sessions.get(first.issued.sid)?.state, "closed");
  assert.equal(state.desktopRoutes.get(MID)?.activeStream?.sid, second.issued.sid);
  // streamId 单调递增不复用。
  assert.ok(secondBind.streamId > firstBind.streamId);
});

test("自顶替：同 sid 重连关旧管道并复用会话", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const { issued, bind } = issueAndBind(state, Date.now());
  assert.ok(bind.ok);
  state.bindPhoneStream(MID, issued.sid);

  const rebind = state.bindPhoneStream(MID, issued.sid);
  assert.deepEqual(
    rebind.effects.map((effect) => effect.kind),
    ["close_phone", "stream_open"],
  );
  assert.equal(state.sessions.get(issued.sid)?.state, "bound");
});

test("grace：手机断开进入等待，重连恢复，超时作废", () => {
  const { state, advance } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const { issued } = issueAndBind(state, Date.now());
  state.bindPhoneStream(MID, issued.sid);

  const lost = state.phoneDisconnected(issued.sid);
  assert.deepEqual(
    lost.map((effect) => effect.kind),
    ["stream_close"],
  );
  assert.equal(state.sessions.get(issued.sid)?.state, "grace");

  // grace 内重连恢复 bound。
  advance(4 * 60_000);
  const rebind = state.bindPhoneStream(MID, issued.sid);
  assert.ok(rebind.streamId >= 0);
  assert.equal(state.sessions.get(issued.sid)?.state, "bound");

  // 再断开并超过 5min：sweep 关闭。
  state.phoneDisconnected(issued.sid);
  advance(5 * 60_000 + 1);
  state.sweep();
  assert.equal(state.sessions.get(issued.sid)?.state, "closed");
});

test("revoke：桌面主动注销 → 手机 4004、会话作废", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const { issued } = issueAndBind(state, Date.now());
  state.bindPhoneStream(MID, issued.sid);

  const effects = state.revokeSession(issued.sid);
  assert.deepEqual(
    effects.map((effect) => effect.kind),
    ["close_phone", "stream_close"],
  );
  const closePhone = effects[0] as { kind: "close_phone"; code: number };
  assert.equal(closePhone.code, 4004);
  assert.equal(state.sessions.get(issued.sid)?.state, "closed");
});

test("单活票据：未占用旧票据作废；bound/grace 会话不被重签打断（spec §21.1/§21.8）", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });

  // 场景一：pending 旧票据（无人使用）→ 重签即作废（close_phone 无管道可达，仅状态关闭）。
  const unclaimed = state.issueSession(MID);
  const second = state.issueSession(MID, { persistent: true });
  assert.equal(state.desktopRoutes.get(MID)?.activeTicketSid, second.sid);
  assert.equal(state.sessions.get(unclaimed.sid)?.state, "closed");
  assert.ok(!second.effects.some((effect) => effect.kind === "session_invalid"));

  // 场景二：旧票据已绑定在线 → 重签不打断：会话保持 bound、路由不动。
  state.bindTicket({
    sid: second.sid,
    hash: computeAccessHash(SECRET, second.sid, MID, second.issuedAt, true),
    t: second.issuedAt,
    mid: MID,
  });
  state.bindPhoneStream(MID, second.sid);
  const third = state.issueSession(MID, { persistent: true });
  assert.equal(state.desktopRoutes.get(MID)?.activeTicketSid, third.sid);
  assert.equal(state.sessions.get(second.sid)?.state, "bound", "在线会话不被票据替换打断");
  assert.equal(state.desktopRoutes.get(MID)?.activeStream?.sid, second.sid, "路由保持");
  assert.deepEqual(
    third.effects.map((effect) => effect.kind),
    [],
    "无副作用",
  );
});

test("P2P 会话桌面主动断开：补发 stream_close(phone_stop)，旧 token 重连收 4006（spec §21.2）", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const first = state.issueSession(MID, { persistent: true });
  const hash = computeAccessHash(SECRET, first.sid, MID, first.issuedAt, true);
  const bindA = state.bindTicket({ sid: first.sid, hash, t: first.issuedAt, mid: MID });
  assert.ok(bindA.ok);
  state.bindPhoneStream(MID, first.sid);
  state.phonePromotedToP2p(first.sid); // 中转流退役，会话保留旧 streamId。

  const effects = state.disconnectSession(first.sid);
  const stop = effects.find(
    (effect) => effect.kind === "stream_close" && effect.reason === "phone_stop",
  );
  assert.ok(stop, "P2P 会话断开仍补发 stream_close(phone_stop)");
  assert.equal((stop as { streamId: number }).streamId, 0, "streamId 用会话保留旧值");
  assert.equal(state.sessions.get(first.sid)?.state, "pending", "票据保留可重连");

  // 旧手机凭被作废 token 回连：收 4006（已在电脑端断开），而非 4004。
  const retry = state.checkPhoneUpgrade(first.sid, bindA.sessionToken);
  assert.ok(!retry.ok);
  assert.equal(retry.closeCode, 4006);
  // 无关 token 仍收 4004。
  const other = state.checkPhoneUpgrade(first.sid, "not-a-token");
  assert.equal(other.closeCode, 4004);
});

test("同 sid 新设备转移：P2P 旧设备被通知拆除（spec §21.9）", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const first = state.issueSession(MID, { persistent: true });
  const hash = computeAccessHash(SECRET, first.sid, MID, first.issuedAt, true);
  const bindA = state.bindTicket({ sid: first.sid, hash, t: first.issuedAt, mid: MID });
  assert.ok(bindA.ok);
  state.bindPhoneStream(MID, first.sid);
  state.phonePromotedToP2p(first.sid);

  // 设备 B 扫同码：bind 重铸 token → 升级时须发 stream_close(kicked) 拆 A 的 P2P。
  const bindB = state.bindTicket({ sid: first.sid, hash, t: first.issuedAt, mid: MID });
  assert.ok(bindB.ok);
  const upgrade = state.bindPhoneStream(MID, first.sid);
  const kicked = upgrade.effects.find(
    (effect) => effect.kind === "stream_close" && effect.reason === "kicked",
  );
  assert.ok(kicked, "同 sid 转移发 stream_close(kicked)");
  assert.equal((kicked as { streamId: number }).streamId, 0);
  assert.ok(upgrade.effects.some((effect) => effect.kind === "stream_open"));
  // 标记消费后，同 token 再次自顶替不再误发踢人通知。
  const again = state.bindPhoneStream(MID, first.sid);
  assert.ok(
    !again.effects.some((effect) => effect.kind === "stream_close" && effect.reason === "kicked"),
    "标记一次性",
  );
});

test("P2P 升级会话被顶替：仍向桌面发 stream_close(kicked)（spec §21.9）", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const first = state.issueSession(MID, { persistent: true });
  const hash = computeAccessHash(SECRET, first.sid, MID, first.issuedAt, true);
  state.bindTicket({ sid: first.sid, hash, t: first.issuedAt, mid: MID });
  state.bindPhoneStream(MID, first.sid);
  // 手机 A 升级 P2P：中转流退役但会话保留旧 streamId。
  state.phonePromotedToP2p(first.sid);
  assert.equal(state.desktopRoutes.get(MID)?.activeStream, undefined);

  // 手机 B 接入：踢 A——即使无活跃中转流，也必须通知桌面拆 RTC。
  const second = state.issueSession(MID, { persistent: true });
  const hashB = computeAccessHash(SECRET, second.sid, MID, second.issuedAt, true);
  state.bindTicket({ sid: second.sid, hash: hashB, t: second.issuedAt, mid: MID });
  const bind = state.bindPhoneStream(MID, second.sid);
  const kicked = bind.effects.find(
    (effect) => effect.kind === "stream_close" && effect.reason === "kicked",
  );
  assert.ok(kicked, "升级会话被踢仍发 stream_close(kicked)");
  assert.equal((kicked as { streamId: number }).streamId, 0, "streamId 用会话保留的旧值");
});

test("被顶替设备重连收 4001 而非 4004（spec §21.6）", () => {
  const { state, now, advance } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });

  // 场景一：同二维码转移（同 sid 重铸 token），旧设备凭旧 token 重连。
  const first = state.issueSession(MID, { persistent: true });
  const hash = computeAccessHash(SECRET, first.sid, MID, first.issuedAt, true);
  const bindA = state.bindTicket({ sid: first.sid, hash, t: first.issuedAt, mid: MID });
  assert.ok(bindA.ok);
  state.bindPhoneStream(MID, first.sid);
  const bindB = state.bindTicket({ sid: first.sid, hash, t: first.issuedAt, mid: MID });
  assert.ok(bindB.ok && bindB.sessionToken !== bindA.sessionToken);
  const retryA = state.checkPhoneUpgrade(first.sid, bindA.sessionToken);
  assert.ok(!retryA.ok);
  assert.equal(retryA.closeCode, 4001, "旧 token 重连收 4001");

  // 场景二：跨 sid 踢人（新票据），旧会话作废后旧设备重连。
  const second = state.issueSession(MID, { persistent: true });
  const hashB = computeAccessHash(SECRET, second.sid, MID, second.issuedAt, true);
  const bindC = state.bindTicket({ sid: second.sid, hash: hashB, t: second.issuedAt, mid: MID });
  assert.ok(bindC.ok);
  state.bindPhoneStream(MID, second.sid);
  assert.equal(state.sessions.get(first.sid)?.state, "closed", "旧 sid 被踢作废");
  const retryB = state.checkPhoneUpgrade(first.sid, bindB.sessionToken);
  assert.ok(!retryB.ok);
  assert.equal(retryB.closeCode, 4001, "被踢会话的最新 token 重连也收 4001");

  // 无关 token 仍收 4004。
  const retryRandom = state.checkPhoneUpgrade(first.sid, "not-a-token");
  assert.equal(retryRandom.closeCode, 4004);
  advance(0);
});

test("disconnectSession：手机 4006、会话回退 pending 可重新 bind（spec §21.2）", () => {
  const { state, now } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const { issued, bind } = issueAndBind(state, now);
  assert.ok(bind.ok);
  state.bindPhoneStream(MID, issued.sid);

  const effects = state.disconnectSession(issued.sid);
  const closePhone = effects[0] as { kind: "close_phone"; code: number; reason: string };
  assert.equal(closePhone.code, 4006);
  assert.equal(closePhone.reason, "desktop-disconnected");
  assert.ok(effects.some((effect) => effect.kind === "stream_close"));
  const session = state.sessions.get(issued.sid)!;
  assert.equal(session.state, "pending", "断开后票据保留可重连");
  assert.equal(session.sessionToken, undefined);
  assert.equal(state.desktopRoutes.get(MID)?.activeStream, undefined);

  // 手机凭同一票据重新 bind → 新 token、可再次升级管道。
  const rebind = state.bindTicket({
    sid: issued.sid,
    hash: computeAccessHash(SECRET, issued.sid, MID, now),
    t: now,
    mid: MID,
  });
  assert.ok(rebind.ok);
  const streamBind = state.bindPhoneStream(MID, issued.sid);
  assert.ok(streamBind.streamId >= 0);
  assert.equal(state.sessions.get(issued.sid)?.state, "bound");
});

test("桌面断开：手机管道 4002、会话转 grace", () => {
  const { state } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const { issued } = issueAndBind(state, Date.now());
  state.bindPhoneStream(MID, issued.sid);

  const effects = state.desktopDisconnected(MID);
  assert.deepEqual(
    effects.map((effect) => effect.kind),
    ["close_phone"],
  );
  const closePhone = effects[0] as { kind: "close_phone"; code: number };
  assert.equal(closePhone.code, 4002);
  assert.equal(state.sessions.get(issued.sid)?.state, "grace");
  assert.equal(state.desktopRoutes.get(MID)?.activeStream, undefined);
});

test("sweep：短时票据过期作废；ready 超时回退 pending 可再 bind；token 过期断管道", () => {
  const { state, advance } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });

  // 短时票据过期。
  const expiredTicket = state.issueSession(MID);
  advance(10 * 60_000 + 1);
  let effects = state.sweep();
  assert.equal(state.sessions.get(expiredTicket.sid)?.state, "closed");
  assert.ok(effects.some((effect) => effect.kind === "session_invalid"));

  // ready 60s 未升级：token 作废回退 pending，票据仍可再次 bind（spec §21.1）。
  const { issued, bind } = issueAndBind(state, 5_000_000);
  assert.ok(bind.ok);
  advance(61_000);
  effects = state.sweep();
  const session = state.sessions.get(issued.sid)!;
  assert.equal(session.state, "pending");
  assert.equal(session.sessionToken, undefined);
  assert.ok(!effects.some((effect) => effect.kind === "session_invalid"));
  const rebind = state.bindTicket({
    sid: issued.sid,
    hash: computeAccessHash(SECRET, issued.sid, MID, 5_000_000),
    t: 5_000_000,
    mid: MID,
  });
  assert.ok(rebind.ok, "ready 超时后票据仍可重新 bind");

  // 会话凭证 2h 无活跃过期：bound 管道被断。
  state.bindPhoneStream(MID, issued.sid);
  advance(2 * 60 * 60_000 + 1);
  effects = state.sweep();
  assert.equal(state.sessions.get(issued.sid)?.state, "closed");
  assert.ok(effects.some((effect) => effect.kind === "stream_close"));
  assert.ok(effects.some((effect) => effect.kind === "close_phone"));
});

test("滑动续期：数据流量推迟 token 过期", () => {
  const { state, advance } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  state.desktopRoutes.set(MID, { nextStreamId: 0 });
  const { issued } = issueAndBind(state, Date.now());
  state.bindPhoneStream(MID, issued.sid);

  advance(90 * 60_000);
  state.touchSession(issued.sid); // 活跃续期。
  advance(90 * 60_000); // 距 bind 180min，但距 touch 仅 90min。
  state.sweep();
  assert.notEqual(state.sessions.get(issued.sid)?.state, "closed");
});

test("sweep 回收：closed 会话超过保留窗口后被物理删除", () => {
  const { state, advance } = fixture();
  state.registerDevice({ mid: MID, name: "Mac", appVersion: "1.0.0" });
  const issued = state.issueSession(MID);
  advance(REMOTE_CONTROL_TICKET_TTL_MS + 1);
  state.sweep(); // pending → closed（closedAt 记录）。
  assert.equal(state.sessions.get(issued.sid)?.state, "closed");
  advance(10 * 60_000 + 1); // 超过 CLOSED_SESSION_RETENTION_MS。
  state.sweep();
  assert.equal(state.sessions.has(issued.sid), false, "closed 会话物理删除");
});
