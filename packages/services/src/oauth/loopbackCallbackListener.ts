import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 通用 OAuth loopback 回调监听（RFC 8252 形态 A）。
 *
 * 自 chatgptOAuthClient 的 1455 监听提取（2026-10-20）：state 精确校验、
 * 本地成功/失败页、超时/取消/端口占用语义与原实现一致；新增 127.0.0.1:0
 * 随机端口支持（KeyCloak 对回环地址允许端口通配 redirect 注册一次即可）。
 * 纯 IO 适配层：不持有任何账号事实，交换与写库由调用方编排。
 */

export interface LoopbackOAuthListener {
  readonly port: number;
  /** 等待授权完成；resolve = 拿到 code 且 onCode 编排成功，reject = 超时/取消/交换前失败。 */
  readonly done: Promise<{ code: string }>;
  close(): void;
}

export const LOOPBACK_CALLBACK_PORT_IN_USE = "loopback-callback-port-in-use";

/** 监听器错误统一形态：errorCode ∈ port-in-use / cancelled / timeout / denied:{oauth_error}。 */
export class LoopbackOAuthError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "LoopbackOAuthError";
  }
}

const DEFAULT_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Mikiko</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style></head>
<body><div><h1>已登录</h1><p>正在返回 Mikiko，可关闭此页面。</p></div></body></html>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char: string) => `&#${char.charCodeAt(0)};`);
}

export function startLoopbackOAuthListener(params: {
  expectedState: string;
  onCode: (code: string) => Promise<void>;
  /** 0 = 随机端口（默认）。 */
  port?: number;
  /** 默认 "/callback"。 */
  path?: string;
  timeoutMs?: number;
  successHtml?: string;
}): Promise<LoopbackOAuthListener> {
  const port = params.port ?? 0;
  const callbackPath = params.path ?? "/callback";
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
      // base 仅用于解析 pathname/searchParams，与实际绑定端口无关（随机端口时 port=0）。
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === callbackPath) {
        const code = url.searchParams.get("code")?.trim();
        const state = url.searchParams.get("state")?.trim();
        const error = url.searchParams.get("error")?.trim();
        if (error) {
          settled = true;
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(`<h1>授权失败</h1><p>${escapeHtml(error)}</p>`);
          close();
          doneReject(new LoopbackOAuthError(`授权被拒绝: ${error}`, `denied:${error}`));
          return;
        }
        if (!code || state !== params.expectedState) {
          // state 不匹配只拒绝该次请求不关监听：可能是扫描器/过期标签页的迟到回调，
          // 真正的回调仍可能在路上。
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end("<h1>State mismatch</h1>");
          return;
        }
        settled = true;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(params.successHtml ?? DEFAULT_SUCCESS_HTML);
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
        rejectListener(new LoopbackOAuthError("回环回调端口被占用", LOOPBACK_CALLBACK_PORT_IN_USE));
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
            doneReject(new LoopbackOAuthError("授权已取消", "cancelled"));
          }
          close();
        },
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        close();
        doneReject(new LoopbackOAuthError("授权超时，请重试", "timeout"));
      }, params.timeoutMs ?? 10 * 60_000);
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
