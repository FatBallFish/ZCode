import { Server, type Tool, type CallToolResult } from "@modelcontextprotocol/server";
import type { ComputerUseOpenContract } from "./contract.js";

export function createPreviewServer(controller: ComputerUseOpenContract, production = false) {
  const server = new Server(
    { name: "mikiko-computer-use", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: production
        ? "Mikiko local Computer Use. List applications, select a bundle ID and observe before actions. Only main local desktop sessions are admitted. Stop releases this session control. No remote or subagent control."
        : "Local Mikiko Computer Use preview. Only configured test apps are allowed. Observe each turn before actions. Not a global desktop lease. No remote or subagent control.",
    },
  );
  if (production) {
    server.setNotificationHandler(
      "notifications/mikiko/turn-ended",
      {
        params: {
          "~standard": {
            version: 1 as const,
            vendor: "mikiko",
            validate(value: unknown) {
              return value && typeof value === "object" && !Array.isArray(value)
                ? { value: value as Record<string, unknown> }
                : { issues: [{ message: "Turn completion requires object params" }] };
            },
          },
        },
      },
      async (params) => {
        await controller.endTurn?.((params as Record<string, unknown>)._meta);
      },
    );
  }
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
