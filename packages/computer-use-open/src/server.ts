import { pathToFileURL } from "node:url";
import { Server, type Tool, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createComputerUseController } from "./controller.js";
import type { ComputerUseOpenContract } from "./contract.js";
import { createNativePort } from "./native.js";

export function createPreviewServer(controller: ComputerUseOpenContract) {
  const server = new Server(
    { name: "mikiko-computer-use", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Local Mikiko Computer Use preview. Only configured test apps are allowed. Observe each turn before actions. Not a global desktop lease. No remote or subagent control.",
    },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: (await controller.listTools()) as Tool[],
  }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    try {
      return (await controller.call(
        request.params.name,
        request.params.arguments ?? {},
        extra.mcpReq._meta,
        extra.mcpReq.signal,
      )) as unknown as CallToolResult;
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "native-error" }],
      };
    }
  });
  return server;
}

async function main() {
  process.title = "mikiko-computer-use-mcp";
  const allowed: unknown = JSON.parse(process.env.MIKIKO_COMPUTER_USE_ALLOWED_APPS ?? "[]");
  if (
    !Array.isArray(allowed) ||
    !allowed.every((v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(v))
  ) {
    throw new Error("MIKIKO_COMPUTER_USE_ALLOWED_APPS must be a JSON array of bundle IDs");
  }
  const controller = createComputerUseController(createNativePort(), { allowedApps: allowed });
  const handle = serveStdio(() => createPreviewServer(controller), { legacy: "reject" });
  const stop = async () => {
    await controller.close();
    await handle.close();
  };
  process.stdin.once("end", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(
      `Mikiko Computer Use failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
