import { spawn, type ChildProcess } from "node:child_process";

/**
 * ChatGPT 专用 curl 子进程 fetch（流式）。
 *
 * 背景：Node undici 的默认 TLS ClientHello 指纹会被 chatgpt.com 的 /codex/responses
 * 以伪 401（missing_end_user_auth）拒绝；curl 的系统 TLS 栈可正常通过（实测 macOS
 * LibreSSL HTTP/1.1 与 HTTP/2 均 200）。官方 Codex CLI 用 reqwest(rustls) 同样通过。
 * 因此 chatgpt 域的推理请求走 curl 子进程：`-D -` 把响应头与 body 顺序输出到 stdout，
 * 解析出头块后把剩余字节包装为流式 body（SSE 需要 -N 关闭缓冲）。
 * curl 不可用（ENOENT）时回退全局 fetch，行为退化为上游 401（不影响其他 provider）。
 */

const HEADER_BLOCK_TERMINATOR = "\r\n\r\n";

export function createChatGPTCurlFetch(options?: { curlPath?: string }): typeof fetch {
  const curlPath = options?.curlPath ?? "curl";
  return (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const headerArgs: string[] = [];
    for (const [name, value] of headers.entries()) {
      headerArgs.push("-H", `${name}: ${value}`);
    }
    const body = init?.body;
    const hasBody = body != null && method !== "GET" && method !== "HEAD";
    if (hasBody) {
      // undici 对字符串 body 自动补 application/json；curl --data-binary 默认
      // x-www-form-urlencoded，上游按 content-type 走不同鉴权路径，必须对齐。
      if (!headers.has("content-type")) {
        headerArgs.push("-H", "content-type: application/json");
      }
      headerArgs.push("--data-binary", "@-");
    }
    const args = [
      "-sS",
      "-N",
      "--max-time",
      "600",
      "-D",
      "-",
      "-X",
      method,
      ...headerArgs,
      url,
    ];

    const child = spawn(curlPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const abortSignal = init?.signal;
    const onAbort = () => child.kill("SIGKILL");
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    if (body != null && typeof body !== "string" && !(body instanceof Uint8Array)) {
      child.kill();
      throw new Error("chatgpt curl fetch 仅支持字符串/字节 body");
    }
    child.stdin.on("error", () => {
      /* curl 提前退出时 EPIPE 忽略 */
    });
    child.stdin.end(body as string | Uint8Array | undefined);

    return await new Promise<Response>((resolve, reject) => {
      const stdout = child.stdout;
      let headerBuffer = "";
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        abortSignal?.removeEventListener("abort", onAbort);
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        reject(error);
      };
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          // 无 curl：回退 undici（可能被上游指纹拦截，但不影响装配）。
          fail(new ChatGPTCurlUnavailableError());
          return;
        }
        fail(error);
      });
      child.once("exit", (code) => {
        if (!settled && headerBuffer.length === 0) {
          fail(new Error(`curl exited with code ${String(code)} before headers`));
        }
      });
      stderrCollector(child, (message) => {
        if (!settled && headerBuffer.length === 0) fail(new Error(message));
      });

      const onChunk = (chunk: Buffer) => {
        if (settled) return;
        headerBuffer += chunk.toString("latin1");
        const terminatorIndex = headerBuffer.indexOf(HEADER_BLOCK_TERMINATOR);
        if (terminatorIndex < 0) return;
        settled = true;
        stdout.off("data", onChunk);
        abortSignal?.removeEventListener("abort", onAbort);
        const { status, headers } = parseHeaderBlock(headerBuffer.slice(0, terminatorIndex));
        const remainder =
          terminatorIndex + HEADER_BLOCK_TERMINATOR.length < headerBuffer.length
            ? Buffer.from(headerBuffer.slice(terminatorIndex + HEADER_BLOCK_TERMINATOR.length), "latin1")
            : null;
        resolve(
          new Response(streamWithPrefix(remainder, stdout, child), {
            status,
            headers,
          }),
        );
      };
      stdout.on("data", onChunk);
    });
  }) as typeof fetch;
}

export class ChatGPTCurlUnavailableError extends Error {
  constructor() {
    super("curl binary is unavailable");
    this.name = "ChatGPTCurlUnavailableError";
  }
}

function parseHeaderBlock(block: string): { status: number; headers: Headers } {
  const lines = block.split("\r\n").filter((line) => line.length > 0);
  let status = 200;
  const headers = new Headers();
  for (const line of lines) {
    if (line.startsWith("HTTP/")) {
      const parts = line.split(" ");
      const parsed = Number(parts[1]);
      if (Number.isFinite(parsed)) status = parsed;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  return { status, headers };
}

function streamWithPrefix(
  prefix: Buffer | null,
  source: NodeJS.ReadableStream,
  child: { killed: boolean; kill: () => void },
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix && prefix.length > 0) controller.enqueue(new Uint8Array(prefix));
      source.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          /* 消费端取消后忽略 */
        }
      });
      source.once("end", () => {
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      });
      source.once("error", (error: unknown) => {
        try {
          controller.error(error);
        } catch {
          /* 已关闭 */
        }
      });
    },
    cancel() {
      child.kill();
    },
  });
}

function stderrCollector(child: ChildProcess, onMessage: (message: string) => void): void {
  let buffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("%")) onMessage(trimmed);
    }
  });
}
