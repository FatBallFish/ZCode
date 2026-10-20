import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

export const WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS = {
  "oauth:active_provider": "zai",
  "oauth:zai:access_token": "mock-token",
  "oauth:zai:user_info": JSON.stringify({
    id: "mikiko-e2e-user",
    username: "Mikiko E2E",
    displayName: "Mikiko E2E",
  }),
  zcodejwttoken: "mock-token",
};

/** 自建扫码协议的隔离服务：只鉴权和转发，不保存任何任务、快照或已接纳输入。 */
async function createHmacRelayFixture() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    // 用户明确排除 Relay V2；fixture 不再提供可被误用的 V2 发 token/设备接口。
    if (path.startsWith("/api/v1/remote/")) {
      response.writeHead(404);
      response.end(JSON.stringify({ code: 404, msg: "Relay V2 is not configured" }));
      return;
    }
    response.end(
      JSON.stringify({
        code: 0,
        data:
          path === "/api/v1/client/scenes"
            ? []
            : {
                configs: {},
                builtinModels: [],
                config_version: "session-events",
              },
      }),
    );
  });
  const sockets = new WebSocketServer({ server, perMessageDeflate: true });
  type Role = "device" | "terminal";
  type Device = { passHash: string; device?: WebSocket; terminal?: WebSocket };
  const devices = new Map<string, Device>();
  const send = (socket: WebSocket | undefined, message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const pairStatus = (device: Device) =>
    device.device?.readyState === WebSocket.OPEN && device.terminal?.readyState === WebSocket.OPEN
      ? "matched"
      : "waiting";
  sockets.on("connection", (socket) => {
    let session: { sid: string; role: Role; nonce: string; authenticated: boolean } | undefined;
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "device_register_init") {
        if (typeof message.pass_hash !== "string" || !message.pass_hash) return;
        const sid = randomUUID();
        devices.set(sid, { passHash: message.pass_hash });
        send(socket, { type: "device_register_ack", device_sid: sid });
        return;
      }
      if (message.type === "auth_init") {
        const sid = typeof message.device_sid === "string" ? message.device_sid : "";
        if (!devices.has(sid) || (message.role !== "device" && message.role !== "terminal")) {
          send(socket, { type: "error", code: "AUTH_FAILED", message: "Unknown device" });
          return;
        }
        session = { sid, role: message.role, nonce: randomUUID(), authenticated: false };
        send(socket, { type: "auth_challenge", nonce: session.nonce });
        return;
      }
      if (!session) return;
      const device = devices.get(session.sid);
      if (!device) return;
      if (message.type === "auth_response") {
        const expected = createHmac("sha256", device.passHash)
          .update(`${session.nonce}|${session.role}|${session.sid}`)
          .digest("base64url");
        const proof = typeof message.proof === "string" ? message.proof : "";
        if (
          proof.length !== expected.length ||
          !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
        ) {
          send(socket, { type: "error", code: "AUTH_FAILED", message: "Invalid proof" });
          return;
        }
        device[session.role]?.close();
        device[session.role] = socket;
        session.authenticated = true;
        send(socket, {
          type: "auth_ack",
          device_sid: session.sid,
          pair_status: pairStatus(device),
        });
        send(device[session.role === "device" ? "terminal" : "device"], {
          type: "pair_status_ack",
          pair_status: pairStatus(device),
        });
        return;
      }
      if (!session.authenticated || device[session.role] !== socket) return;
      if (message.type === "pair_status_query") {
        send(socket, { type: "pair_status_ack", pair_status: pairStatus(device) });
      } else if (message.type === "data") {
        send(device[session.role === "device" ? "terminal" : "device"], {
          type: "data",
          payload: message.payload,
        });
      }
    });
    socket.on("close", () => {
      if (!session) return;
      const device = devices.get(session.sid);
      if (!device || device[session.role] !== socket) return;
      delete device[session.role];
      send(device[session.role === "device" ? "terminal" : "device"], {
        type: "pair_status_ack",
        pair_status: "waiting",
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HMAC relay fixture port");
  const httpUrl = `http://127.0.0.1:${address.port}`;
  return {
    httpUrl,
    wsUrl: `${httpUrl.replace("http:", "ws:")}/ws`,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolveClose) => sockets.close(() => resolveClose()));
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** 单窗口真实 Host/RPC/renderer 回归，只替换外部自建 relay 和独立 Web 服务。 */
export async function prepareWebRemoteControlSessionEventsFixture(options: {
  credentialsFile: string;
  settingsFile: string;
  workspacePath: string;
  serveWeb?: boolean;
}): Promise<() => Promise<void>> {
  const relay = await createHmacRelayFixture();
  const envPatch: Record<string, string> = {
    ...(options.serveWeb ? { VITE_ZCODE_E2E_STORE_BRIDGE: "1" } : {}),
    ZAI_BUSINESS_BASE_URL: relay.httpUrl,
    ZCODE_E2E_REMOTE_AUTH_GATE_URL: relay.httpUrl,
    MIKIKO_BASE_URL: relay.httpUrl,
    MIKIKO_ENDPOINT_ORIGIN: relay.httpUrl,
    MIKIKO_TEST_BASE_URL: relay.httpUrl,
    MIKIKO_WEB_REMOTE_CONTROL_RELAY_WS_URL: relay.wsUrl,
    MIKIKO_WEB_REMOTE_CONTROL_URL: `${relay.httpUrl}/remote/v4`,
  };
  const previous = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envPatch);
  // Vite 8 把 CLI --port 0 回退成5173。由本次fixture的HTTP server直接listen(0)，
  // 并挂载Vite middleware/HMR，端口从创建到结束始终由同一个进程持有。
  const web = options.serveWeb
    ? spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
    import { createServer as createHttpServer } from "node:http";
    import { createServer as createViteServer } from "vite";
    let vite;
    const http = createHttpServer((request, response) => vite.middlewares(request, response));
    vite = await createViteServer({ server: { middlewareMode: true, hmr: { server: http } } });
    http.listen(0, "127.0.0.1", async () => {
      await vite.environments.client.depsOptimizer?.scanProcessing;
      console.log("http://127.0.0.1:" + http.address().port);
    });
    process.once("SIGTERM", async () => {
      await vite.close();
      http.closeAllConnections();
      http.close(() => process.exit(0));
    });
  `,
        ],
        {
          cwd: resolve(import.meta.dirname, "../../../../../packages/web"),
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    : undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (web && web.exitCode === null) {
      const exited = once(web, "exit");
      web.kill();
      await exited;
    }
    await relay.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    if (web) {
      const origin = await new Promise<string>((resolveReady, reject) => {
        web.once("error", reject);
        web.once("exit", (code) =>
          reject(new Error(`Mobile Web fixture exited before ready: ${code}`)),
        );
        web.stdout.on("data", (chunk) => {
          const match = String(chunk)
            .replace(/\u001b\[[0-9;]*m/g, "")
            .match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) resolveReady(match[0]);
        });
        web.stderr.on("data", (chunk) => process.stderr.write(chunk));
      });
      process.env.MIKIKO_WEB_REMOTE_CONTROL_URL = `${origin}/remote/v4`;
    }
    await writeFile(
      options.credentialsFile,
      JSON.stringify(WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS),
      { mode: 0o600 },
    );
    const settings = JSON.parse(await readFile(options.settingsFile, "utf8"));
    await writeFile(
      options.settingsFile,
      JSON.stringify({
        ...settings,
        zcodeEndpointOrigin: relay.httpUrl,
        webRemoteControlLastEnabledContext: { workspacePath: options.workspacePath },
      }),
    );
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
