import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mapClientScenesToDraftSuggestedPromptItems } from "@/v4/draftSuggestedPromptItems.js";
import { prepareWebRemoteControlAuthGateFixture } from "#e2e/helpers/web-remote-control-auth-gate-fixture";

it("keeps cached-account business requests inside the auth-gate fixture and restores its environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-auth-fixture-"));
  const credentialsFile = join(root, "credentials.json");
  const settingsFile = join(root, "setting.json");
  const previous = process.env.ZAI_BUSINESS_BASE_URL;
  process.env.ZAI_BUSINESS_BASE_URL = "https://business.example.invalid";
  let close: (() => Promise<void>) | null = null;
  try {
    await writeFile(settingsFile, "{}");
    close = await prepareWebRemoteControlAuthGateFixture({
      specs: ["web-remote-control-auth-gate.test.ts"],
      credentialsFile,
      settingsFile,
      workspacePath: root,
    });
    expect(close).not.toBeNull();
    expect(process.env.ZAI_BUSINESS_BASE_URL).toBe(process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL);
    await close!();
    close = null;
    expect(process.env.ZAI_BUSINESS_BASE_URL).toBe("https://business.example.invalid");
  } finally {
    await close?.();
    if (previous === undefined) delete process.env.ZAI_BUSINESS_BASE_URL;
    else process.env.ZAI_BUSINESS_BASE_URL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "conversation-session-virtual-project-mobile.test.ts",
  "conversation-session-web-remote-project-directory.test.ts",
  "conversation-session-web-remote-unread.test.ts",
])(
  "provides %s with an isolated authenticated relay and the current Web frontend",
  async (spec) => {
    const root = await mkdtemp(join(tmpdir(), "remote-mobile-fixture-"));
    const credentialsFile = join(root, "credentials.json");
    const settingsFile = join(root, "setting.json");
    const previousUrl = process.env.MIKIKO_WEB_REMOTE_CONTROL_URL;
    const previousForceColor = process.env.FORCE_COLOR;
    // wdio CLI 会给 worker 注入 FORCE_COLOR（非 TTY 为 "0"，TTY 为 "1"），fixture 必须在该环境下识别 Web 就绪。
    process.env.FORCE_COLOR = "0";
    let close: (() => Promise<void>) | null = null;
    try {
      await writeFile(settingsFile, "{}");
      close = await prepareWebRemoteControlAuthGateFixture({
        specs: [spec],
        credentialsFile,
        settingsFile,
        workspacePath: root,
      });
      expect(close).not.toBeNull();
      expect(process.env.MIKIKO_WEB_REMOTE_CONTROL_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/remote\/v4$/,
      );
      const frontend = await fetch(process.env.MIKIKO_WEB_REMOTE_CONTROL_URL!);
      expect(frontend.status).toBe(200);
      expect(await frontend.text()).toContain("/src/main.tsx");
      const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL!;
      expect(new URL(origin).hostname).toBe("127.0.0.1");
      expect(process.env.ZAI_BUSINESS_BASE_URL).toBe(origin);
      const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
      expect(credentials["oauth:active_provider"]).toBe("zai");
      const token = await fetch(new URL("/api/v1/remote/token", origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.zcodejwttoken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "terminal" }),
      });
      // 用户排除 Relay V2；移动项目场景必须通过原自建扫码鉴权而非换发 V2 token。
      expect(token.status).toBe(404);
      const scenes = await (await fetch(new URL("/api/v1/client/scenes", origin))).json();
      expect(mapClientScenesToDraftSuggestedPromptItems(scenes.data)).toEqual([]);
      await close!();
      close = null;
      expect(process.env.MIKIKO_WEB_REMOTE_CONTROL_URL).toBe(previousUrl);
      await expect(fetch(new URL("/api/v1/remote/device", origin))).rejects.toThrow();
    } finally {
      await close?.();
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("自建 fixture 使用真实 HMAC challenge 鉴权和双向转发，不依赖 Relay V2 token", async () => {
  const { createHmac } = await import("node:crypto");
  const { once } = await import("node:events");
  const { WebSocket } = await import("ws");
  const root = await mkdtemp(join(tmpdir(), "mikiko-hmac-relay-"));
  const credentialsFile = join(root, "credentials.json");
  const settingsFile = join(root, "setting.json");
  await writeFile(settingsFile, "{}");
  const close = await prepareWebRemoteControlAuthGateFixture({
    specs: ["web-remote-control-session-events.test.ts"],
    credentialsFile,
    settingsFile,
    workspacePath: root,
  });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  const exchange = async (socket: InstanceType<typeof WebSocket>, message: object) => {
    const reply = once(socket, "message");
    socket.send(JSON.stringify(message));
    return JSON.parse(String((await reply)[0]));
  };
  try {
    const wsUrl = process.env.MIKIKO_WEB_REMOTE_CONTROL_RELAY_WS_URL!;
    const device = new WebSocket(wsUrl);
    sockets.push(device);
    await once(device, "open");
    const registered = await exchange(device, {
      type: "device_register_init",
      pass_hash: "fixture-hash",
      device_mid: "fixture-mid",
      meta: {},
    });
    expect(registered.type).toBe("device_register_ack");
    const sid = registered.device_sid;
    const auth = async (socket: InstanceType<typeof WebSocket>, role: "device" | "terminal") => {
      const challenge = await exchange(socket, {
        type: "auth_init",
        role,
        device_sid: sid,
        meta: {},
      });
      expect(challenge.type).toBe("auth_challenge");
      const proof = createHmac("sha256", "fixture-hash")
        .update(`${challenge.nonce}|${role}|${sid}`)
        .digest("base64url");
      return exchange(socket, { type: "auth_response", device_sid: sid, proof });
    };
    expect(await auth(device, "device")).toMatchObject({
      type: "auth_ack",
      pair_status: "waiting",
    });
    const terminal = new WebSocket(wsUrl);
    sockets.push(terminal);
    await once(terminal, "open");
    expect(await auth(terminal, "terminal")).toMatchObject({
      type: "auth_ack",
      pair_status: "matched",
    });
    const forwarded = once(terminal, "message");
    device.send(
      JSON.stringify({
        type: "data",
        payload: { zcode_type: "fixture-evidence", commandId: "command-1" },
      }),
    );
    expect(JSON.parse(String((await forwarded)[0]))).toEqual({
      type: "data",
      payload: { zcode_type: "fixture-evidence", commandId: "command-1" },
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});
