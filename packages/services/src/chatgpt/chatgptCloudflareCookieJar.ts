import { isChatGPTBackendHost, isChatGPTCloudflareCookieName } from "@zcode/shared";

/**
 * ChatGPT Cloudflare 基础设施 cookie 白名单 jar（官方 chatgpt_cloudflare_cookies.rs 移植）。
 *
 * 只保存 CF 服务 cookie 与 OpenAI 路由 cookie（__oailb），仅对 chatgpt.com /
 * chat.openai.com 域生效；绝不保存账号/会话 cookie。进程内存态，重启重建。
 */
export class ChatGPTCloudflareCookieJar {
  readonly #cookies = new Map<string, { value: string; expiresAtMs?: number }>();

  /** 生成请求 Cookie 头；无可回放 cookie 或过期时返回 undefined。 */
  cookieHeader(hostname: string, now = Date.now()): string | undefined {
    if (!isChatGPTBackendHost(hostname)) return undefined;
    const pairs: string[] = [];
    for (const [name, cookie] of this.#cookies) {
      if (cookie.expiresAtMs != null && cookie.expiresAtMs <= now) {
        this.#cookies.delete(name);
        continue;
      }
      pairs.push(`${name}=${cookie.value}`);
    }
    return pairs.length > 0 ? pairs.join("; ") : undefined;
  }

  /** 从响应 Set-Cookie 列表收集白名单 cookie（含删除语义：Max-Age=0 / expires 过去）。 */
  store(hostname: string, setCookieHeaders: readonly string[], now = Date.now()): void {
    if (!isChatGPTBackendHost(hostname) || setCookieHeaders.length === 0) return;
    for (const raw of setCookieHeaders) {
      const segments = raw.split(";");
      const [namePart, valuePart] = (segments[0] ?? "").trim().split("=");
      const name = namePart?.trim();
      if (!name || !isChatGPTCloudflareCookieName(name)) continue;
      let expiresAtMs: number | undefined;
      for (const attribute of segments.slice(1)) {
        const trimmed = attribute.trim().toLowerCase();
        if (trimmed.startsWith("max-age=")) {
          const seconds = Number(trimmed.slice("max-age=".length));
          if (Number.isFinite(seconds)) expiresAtMs = now + seconds * 1000;
        } else if (trimmed.startsWith("expires=")) {
          const parsed = Date.parse(attribute.trim().slice("expires=".length));
          if (Number.isFinite(parsed)) expiresAtMs = parsed;
        }
      }
      if (!valuePart || valuePart.trim() === "" || (expiresAtMs != null && expiresAtMs <= now)) {
        this.#cookies.delete(name);
        continue;
      }
      this.#cookies.set(name, { value: valuePart.trim(), ...(expiresAtMs ? { expiresAtMs } : {}) });
    }
  }
}
