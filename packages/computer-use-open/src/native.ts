import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { NativeComputerPort, NativeResult } from "./contract.js";

export function createNativePort(env: NodeJS.ProcessEnv = process.env): NativeComputerPort {
  const binary = env.MIKIKO_COMPUTER_USE_BINARY;
  if (!binary || !isAbsolute(binary))
    throw new Error(
      "binary-missing: MIKIKO_COMPUTER_USE_BINARY must be an absolute executable path",
    );
  const client = new Client({ name: "mikiko-computer-use-gateway", version: "0.1.0" });
  let connection: Promise<void> | undefined;
  let closed = false;
  let closure: Promise<void> | undefined;
  const connectionLifetime = new AbortController();
  const nativeEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  Object.assign(nativeEnv, {
    MIKIKO_COMPUTER_USE_CONFIG_FILE:
      env.MIKIKO_COMPUTER_USE_CONFIG_FILE ||
      join(homedir(), ".mikiko", "computer-use", "config.json"),
    MIKIKO_COMPUTER_USE_VISUAL_CURSOR: "0",
    MIKIKO_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "0",
    MIKIKO_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: "mikiko-preview",
  });
  const transport = new StdioClientTransport({
    command: binary,
    args: ["mcp"],
    env: nativeEnv,
    stderr: "pipe",
  });
  // 原生日志可能包含窗口标题/内容；不转发到普通用户日志或stdio协议。
  const connect = async () => {
    if (closed) throw new Error("disposed");
    connection ??= (async () => {
      await access(binary, constants.X_OK);
      if (closed) throw new Error("disposed");
      await client.connect(transport, { timeout: 10_000, signal: connectionLifetime.signal });
      if (closed) {
        await transport.close();
        throw new Error("disposed");
      }
      transport.stderr?.on("data", () => {});
    })();
    await connection;
  };
  return {
    async listTools() {
      await connect();
      return (await client.listTools()).tools;
    },
    async call(name, args, signal) {
      await connect();
      return (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 30_000,
      })) as NativeResult;
    },
    async endTurn() {
      await connect();
      await client.notification({ method: "notifications/turn-ended" });
    },
    close() {
      if (closure) return closure;
      closed = true;
      connectionLifetime.abort();
      closure = (async () => {
        try {
          await client.close();
        } finally {
          await transport.close();
          await connection?.catch(() => {});
          await transport.close();
        }
      })();
      return closure;
    },
  };
}
