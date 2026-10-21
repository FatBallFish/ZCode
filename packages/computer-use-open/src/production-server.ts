import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPreviewServer } from "./mcp-server.js";
import { createNativePort } from "./native.js";
import { createProductionComputerUseController } from "./production.js";

process.title = "mikiko-computer-use-mcp";
const controller = createProductionComputerUseController(() =>
  createNativePort(process.env, { production: true }),
);
const handle = serveStdio(() => createPreviewServer(controller, true), { legacy: "reject" });
let stopped: Promise<void> | undefined;
const stop = () =>
  (stopped ??= (async () => {
    try {
      await controller.close();
    } finally {
      await handle.close();
    }
  })());
for (const event of ["SIGTERM", "SIGINT"] as const) {
  process.once(event, () => {
    void stop();
  });
}
process.stdin.once("end", () => {
  void stop();
});
