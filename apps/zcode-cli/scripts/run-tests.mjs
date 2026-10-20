import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const forwardedArgs = process.argv.slice(2);
if (forwardedArgs[0] === "--") forwardedArgs.shift();
// 完整链包含真实 SQLite 与多进程测试，默认逐包调度；显式资源参数仍由调用者决定。
const hasConcurrency = forwardedArgs.some(
  (arg) => arg === "--concurrency" || arg.startsWith("--concurrency="),
);
// 嵌套 CLI workspace 的 pnpm 不会自动加入外层 .bin；统一补齐，避免全量门禁漏跑。
const child = spawn(
  process.execPath,
  [
    join(root, "node_modules/turbo/bin/turbo"),
    "run",
    "test",
    "--cwd",
    cli,
    ...(hasConcurrency ? [] : ["--concurrency=1"]),
    ...forwardedArgs,
  ],
  {
    cwd: cli,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${join(root, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
      VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? "1",
    },
  },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
