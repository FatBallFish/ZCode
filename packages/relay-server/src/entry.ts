import { randomBytes } from "node:crypto";
import { startRelayServer } from "./server.js";

/**
 * relay 独立进程入口（spec §6.1 部署形态）。
 *
 * 环境变量：
 *   RELAY_PORT            监听端口（默认 8787）
 *   RELAY_HOST            监听地址（默认 0.0.0.0；生产建议由前置 Caddy/Nginx 终止 TLS 并反代本机）
 *   RELAY_SECRET          HMAC 密钥；必填，缺失时生成一次性密钥（重启即全部会话失效，仅限本地调试）
 *   RELAY_WEB_REMOTE_BASE 二维码落地页基址，如 https://m.example.com/remote
 *   RELAY_PUBLIC_WS_BASE  对手机暴露的 WS 基址，如 wss://relay.example.com
 *   RELAY_STUN_URLS       v2 P2P 的 STUN 列表（逗号分隔）
 */

function requiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const secret = requiredEnv("RELAY_SECRET") ?? randomBytes(32).toString("base64url");
const ephemeralSecret = !requiredEnv("RELAY_SECRET");

const listenHost = requiredEnv("RELAY_HOST") ?? "0.0.0.0";
const listenPort = Number(requiredEnv("RELAY_PORT") ?? 8787);

// main() 包一层而非顶层 await：部署打包（esbuild --format=cjs）不支持顶层 await。
async function main(): Promise<void> {
  const handle = await startRelayServer({
    secret,
    webRemoteBase: requiredEnv("RELAY_WEB_REMOTE_BASE") ?? "http://127.0.0.1:5173/remote",
    publicWsBase: requiredEnv("RELAY_PUBLIC_WS_BASE") ?? "ws://127.0.0.1:8787",
    stunUrls: requiredEnv("RELAY_STUN_URLS")
      ?.split(",")
      .map((url) => url.trim())
      .filter(Boolean),
    port: listenPort,
    host: listenHost,
  });

  if (ephemeralSecret) {
    console.warn(
      "[relay] RELAY_SECRET 未设置，已生成一次性密钥：重启后全部会话失效（仅限本地调试）",
    );
  }
  console.log(`[relay] listening on http://${listenHost}:${handle.port}`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`[relay] received ${signal}, closing`);
    await handle.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error("[relay] startup failed", error);
  process.exit(1);
});
