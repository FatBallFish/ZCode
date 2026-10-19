import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, release as osRelease, type as osType } from "node:os";
import {
  CHATGPT_OAUTH_CALLBACK_PATH,
  CHATGPT_OAUTH_CALLBACK_PORT,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_REVOKE_URL,
  CHATGPT_TOKEN_URL,
  CHATGPT_ORIGINATOR,
  CODEX_VERSION_FALLBACK,
  buildCodexUserAgent,
  classifyChatGPTRefreshFailure,
  type ChatGPTRefreshFailureClassification,
} from "@zcode/shared";

/**
 * ChatGPT OAuth HTTP 客户端 + loopback 回调监听（官方 codex-rs login 口径）。
 * 纯 IO 适配层：不做账号事实写入，业务编排见 chatgptAccountService。
 * 出站请求经 request 注入：生产为 host API 网络 transport（设置页 httpProxy/CA 生效），
 * 缺省裸 fetch 仅供测试。
 */

export interface ChatGPTTokenResponse {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn?: number;
}

export class ChatGPTOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorCode?: string,
    readonly classification?: ChatGPTRefreshFailureClassification,
  ) {
    super(message);
    this.name = "ChatGPTOAuthError";
  }
}

/** 1455 端口被占用（常见于 Codex CLI 正在运行/登录中）：授权流程必须中断（用户裁定）。 */
export const CHATGPT_CALLBACK_PORT_IN_USE = "chatgpt-callback-port-in-use";

const OAUTH_REQUEST_TIMEOUT_MS = 20_000;
/** 授权会话整体超时（官方无超时，这里取产品可接受的 10 分钟）。 */
export const CHATGPT_AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;

function authHeaders(): Record<string, string> {
  // 凭据面只发 UA+originator，不发 version（官方 CodexCanonicalAuthIdentity 口径）。
  return {
    "user-agent": buildCodexUserAgent({
      codexVersion: CODEX_VERSION_FALLBACK,
      osType: osType(),
      osVersion: osRelease(),
      arch: arch(),
      terminalToken: "Mikiko",
      uaSimulation: true,
      appVersion: "0",
    }),
    originator: CHATGPT_ORIGINATOR,
  };
}

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

async function readOAuthError(response: Response): Promise<ChatGPTOAuthError> {
  let body: OAuthErrorBody = {};
  try {
    body = (await response.json()) as OAuthErrorBody;
  } catch {
    /* 非 JSON 错误体按网络错误处理 */
  }
  const errorCode = body.error?.trim();
  return new ChatGPTOAuthError(
    body.error_description?.trim() || errorCode || `ChatGPT OAuth HTTP ${response.status}`,
    response.status,
    errorCode,
  );
}

/** 授权码换 token：form-encoded（官方 oauth/client.rs 口径）。 */
export async function exchangeChatGPTCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
  request?: typeof fetch;
}): Promise<ChatGPTTokenResponse> {
  let response: Response;
  try {
    response = await (params.request ?? fetch)(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...authHeaders(),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        code: params.code,
        redirect_uri: params.redirectUri ?? CHATGPT_OAUTH_REDIRECT_URI,
        code_verifier: params.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // 网络错误按 transient/network 包装（对齐 refreshChatGPTToken）：回调成功页已在
    // 兑换前返回浏览器，这里的失败只经 onAuthorizationFailed 透出；不包装则上层
    // 无法区分「连不上」与「上游拒绝」，只能给笼统的「授权失败」文案（2026-10-17
    // 客户案例：浏览器走系统代理完成授权、host 直连失败，排查无日志可依）。
    throw new ChatGPTOAuthError(
      `ChatGPT 授权码兑换网络错误: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      "network",
      { kind: "transient", reason: "network" },
    );
  }
  if (!response.ok) throw await readOAuthError(response);
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!body.access_token?.trim() || !body.refresh_token?.trim()) {
    throw new ChatGPTOAuthError("ChatGPT token 响应缺少 access_token/refresh_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    ...(body.id_token?.trim() ? { idToken: body.id_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresIn: body.expires_in } : {}),
  };
}

/** 刷新 token：JSON body，不带 scope（官方口径，与 sub2api 的 form+scope 不同）。 */
export async function refreshChatGPTToken(params: {
  clientId: string;
  refreshToken: string;
  request?: typeof fetch;
}): Promise<Partial<ChatGPTTokenResponse>> {
  let response: Response;
  try {
    response = await (params.request ?? fetch)(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: params.clientId || CHATGPT_OAUTH_CLIENT_ID,
        refresh_token: params.refreshToken,
      }),
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // 网络错误 → Transient，保留旧 token 可用至 401（官方语义）。
    throw new ChatGPTOAuthError(
      `ChatGPT token 刷新网络错误: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      "network",
      { kind: "transient", reason: "network" },
    );
  }
  if (!response.ok) {
    const error = await readOAuthError(response);
    throw new ChatGPTOAuthError(
      error.message,
      error.status,
      error.errorCode,
      classifyChatGPTRefreshFailure({ status: error.status, errorCode: error.errorCode }),
    );
  }
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  // 官方语义：字段非空才覆盖（refresh_token 可能不返回，支持但不强制轮换）。
  return {
    ...(body.access_token?.trim() ? { accessToken: body.access_token } : {}),
    ...(body.refresh_token?.trim() ? { refreshToken: body.refresh_token } : {}),
    ...(body.id_token?.trim() ? { idToken: body.id_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresIn: body.expires_in } : {}),
  };
}

/** 登出吊销：best-effort，失败仅记日志不阻塞登出（官方 revoke.rs 口径）。 */
export async function revokeChatGPTToken(params: {
  clientId: string;
  refreshToken: string;
  request?: typeof fetch;
}): Promise<void> {
  await (params.request ?? fetch)(CHATGPT_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...authHeaders() },
    body: JSON.stringify({
      token: params.refreshToken,
      token_type_hint: "refresh_token",
      client_id: params.clientId || CHATGPT_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

// ── loopback 回调监听（127.0.0.1:1455，占用即中断） ──

export interface ChatGPTCallbackListener {
  readonly port: number;
  /** 等待授权完成；resolve = 拿到 code 并完成交换编排，reject = 超时/取消/端口占用。 */
  readonly done: Promise<{ code: string }>;
  close(): void;
}

const CALLBACK_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Mikiko</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#10a37f}div{text-align:center}</style></head>
<body><div><h1>已登录</h1><p>正在返回 Mikiko，可关闭此页面。</p></div></body></html>`;

export function startChatGPTCallbackListener(params: {
  expectedState: string;
  onCode: (code: string) => Promise<void>;
  port?: number;
  timeoutMs?: number;
}): Promise<ChatGPTCallbackListener> {
  const port = params.port ?? CHATGPT_OAUTH_CALLBACK_PORT;
  return new Promise((resolveListener, rejectListener) => {
    let server: Server | null = null;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const close = () => {
      if (timer) clearTimeout(timer);
      server?.close();
      server = null;
    };

    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === CHATGPT_OAUTH_CALLBACK_PATH) {
        const code = url.searchParams.get("code")?.trim();
        const state = url.searchParams.get("state")?.trim();
        const error = url.searchParams.get("error")?.trim();
        if (error) {
          settled = true;
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(`<h1>授权失败</h1><p>${escapeHtml(error)}</p>`);
          close();
          doneReject(new ChatGPTOAuthError(`授权被拒绝: ${error}`, undefined, error));
          return;
        }
        if (!code || state !== params.expectedState) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end("<h1>State mismatch</h1>");
          return;
        }
        settled = true;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(CALLBACK_SUCCESS_HTML);
        close();
        void params
          .onCode(code)
          .then(() => doneResolve({ code }))
          .catch((error: unknown) => doneReject(error));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      close();
      if (error.code === "EADDRINUSE") {
        rejectListener(new ChatGPTOAuthError(CHATGPT_CALLBACK_PORT_IN_USE));
        return;
      }
      rejectListener(error);
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      const boundPort = address?.port ?? port;
      resolveListener({
        port: boundPort,
        done,
        close() {
          if (!settled) {
            settled = true;
            doneReject(new ChatGPTOAuthError("授权已取消", undefined, "cancelled"));
          }
          close();
        },
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        close();
        doneReject(new ChatGPTOAuthError("授权超时，请重试", undefined, "timeout"));
      }, params.timeoutMs ?? CHATGPT_AUTHORIZATION_TIMEOUT_MS);
      timer.unref?.();
    });

    let doneResolve: (value: { code: string }) => void;
    let doneReject: (error: unknown) => void;
    const done = new Promise<{ code: string }>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
