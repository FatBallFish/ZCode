import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

/** Own a real native MCP connection without acquiring desktop control. */
export async function keepNativeAgent(binary) {
  const child = spawn(binary, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let text = "";
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native MCP initialization deadline")), 15000);
    const exit = () => {
      clearTimeout(timer);
      reject(new Error("Native MCP exited before initialization"));
    };
    child.once("error", reject);
    child.once("exit", exit);
    child.stdout.on("data", (data) => {
      text += data;
      const i = text.indexOf("\n");
      if (i < 0) return;
      const response = JSON.parse(text.slice(0, i));
      if (response.id !== 1) return;
      clearTimeout(timer);
      child.off("exit", exit);
      if (response.error) reject(new Error("Native initialization rejected"));
      else resolve();
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mikiko-native-acceptance", version: "1" },
        },
      }) + "\n",
    );
  });
  return {
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      const finished = await Promise.race([exited.then(() => true), delay(5000, false)]);
      if (!finished) {
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

export async function waitForNativeSocketClosed() {
  const path = `/tmp/mikiko-computer-use-production-${process.getuid()}.sock`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = createConnection(path);
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
    });
    if (!connected) return;
    await delay(25);
  }
  throw new Error("Last native connection did not close its listener");
}
