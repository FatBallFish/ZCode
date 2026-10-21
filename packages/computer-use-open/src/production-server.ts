import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPreviewServer } from "./mcp-server.js";
import { createNativePort } from "./native.js";
import { createProductionComputerUseController } from "./production.js";

// 插件宿主先import再调用main；仅靠模块副作用会在工具发现后因缺main被宿主退出。
export async function main(): Promise<void> {
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
}

// macOS的/tmp、/var及用户软链接路径会被Node规范化，入口比较必须使用真实路径。
if (
  process.argv[1] &&
  pathToFileURL(await realpath(resolve(process.argv[1]))).href === import.meta.url
)
  await main();
