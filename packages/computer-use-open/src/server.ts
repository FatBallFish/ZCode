import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createComputerUseController } from "./controller.js";
import { createNativePort } from "./native.js";
import { createPreviewServer } from "./mcp-server.js";
export { createPreviewServer } from "./mcp-server.js";

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
