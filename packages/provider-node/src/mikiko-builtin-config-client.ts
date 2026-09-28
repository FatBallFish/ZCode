import { decodeZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "./zcode-builtin-release.js";

export interface MikikoBuiltinConfigClientOptions {
  readonly url: string | URL;
  readonly request: (url: string | URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 20_000;
const BODY_LIMIT_BYTES = 10_000_000;

/**
 * Mikiko 自建模型预置规则单跳下载边界（spec specs/mikiko-cloud/agent-endpoint-plan.md §4.2）。
 *
 * 与官方两跳下载（client/configs → CDN）不同：自建端点固定返回整份 Release JSON。
 * 安全边界沿用官方下载边界——不继承控制面鉴权、不跟随重定向、限制响应体大小；
 * Release 结构校验复用 decodeZCodeBuiltinRelease（schemaVersion/revision/退役 provider 拒绝）。
 */
export async function fetchMikikoBuiltinConfigRelease(
  options: MikikoBuiltinConfigClientOptions,
): Promise<ZCodeBuiltinRelease> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    const json = await readJson(new URL(String(options.url)), signal);
    return decodeZCodeBuiltinRelease(json);
  } catch (error) {
    // 不能把带 query 的 URL、响应正文或 Schema 输入（可能含凭据）交给上层日志。
    const reason = signal.aborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : error instanceof MikikoBuiltinDownloadError
        ? error.message
        : error instanceof Error && error.name === "SyntaxError"
          ? "invalid json"
          : "invalid response";
    throw new Error(`Mikiko builtin config: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  async function readJson(url: URL, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    // 每次新建请求选项，不继承控制面鉴权；不跟随重定向把下载变成任意新来源。
    const response = await abortable(
      options
        .request(url, { method: "GET", signal, credentials: "omit", redirect: "error" })
        .then((value) => {
          if (signal.aborted) {
            void value.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return value;
        }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new MikikoBuiltinDownloadError(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MikikoBuiltinDownloadError("empty body");
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > BODY_LIMIT_BYTES) throw new MikikoBuiltinDownloadError("body limit exceeded");
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      signal.throwIfAborted();
      return JSON.parse(chunks.join("")) as unknown;
    } catch (error) {
      // cancel 不得成为新的无期限等待；释放 reader 后底层请求仍由同一 signal 取消。
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

class MikikoBuiltinDownloadError extends Error {}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
