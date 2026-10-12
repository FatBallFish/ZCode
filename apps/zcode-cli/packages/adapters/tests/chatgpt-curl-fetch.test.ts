import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createChatGPTCurlFetch } from "../src/model/chatgpt-curl-fetch.js";

async function withLocalServer(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("curl fetch：POST 流式响应（头+体解析、header 透传、SSE 不缓冲）", async () => {
  await withLocalServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-custom"], "value-1");
    const requestBody = await readBody(request);
    assert.equal(requestBody, '{"hello":"world"}');
    response.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "42" });
    response.write('data: {"type":"one"}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    response.write('data: {"type":"two"}\n\n');
    response.end();
  }, async (baseUrl) => {
    const curlFetch = createChatGPTCurlFetch();
    const response = await curlFetch(`${baseUrl}/codex/responses`, {
      method: "POST",
      headers: { "x-custom": "value-1", "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-codex-primary-used-percent"), "42");
    const text = await response.text();
    assert.equal(text, 'data: {"type":"one"}\n\ndata: {"type":"two"}\n\n');
  });
});

test("curl fetch：错误状态与响应体透传", async () => {
  await withLocalServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "token_invalidated" } }));
  }, async (baseUrl) => {
    const curlFetch = createChatGPTCurlFetch();
    const response = await curlFetch(`${baseUrl}/x`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
    const parsed = JSON.parse(await response.text()) as { error: { code: string } };
    assert.equal(parsed.error.code, "token_invalidated");
  });
});

test("curl fetch：GET 无 body、AbortSignal 可中断", async () => {
  await withLocalServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    // 持续输出，等待客户端中断。
    response.write("chunk");
    const timer = setInterval(() => response.write("chunk"), 20);
    response.on("close", () => clearInterval(timer));
  }, async (baseUrl) => {
    const curlFetch = createChatGPTCurlFetch();
    const controller = new AbortController();
    const response = await curlFetch(`${baseUrl}/stream`, { method: "GET", signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await assert.doesNotReject(async () => {
      // 读取端在中断后正常结束或抛 AbortError 均可，不应挂死。
      await Promise.race([
        reader.cancel(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reader hung")), 5_000)),
      ]);
    });
  });
});

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
