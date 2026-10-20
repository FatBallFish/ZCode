import { spawn } from "node:child_process";
import { NODE_UNIT_TEST_FILES } from "./node-unit-test-files.mjs";

// 每个文件由 Node test runner 独立进程执行；限制并发，避免真实IO/端口/进程测试互相争用。
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=2",
    "--test-force-exit",
    ...NODE_UNIT_TEST_FILES,
  ],
  {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: process.env,
  },
);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
