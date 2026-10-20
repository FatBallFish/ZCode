import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 只隔离测试子进程；不修改调用方的HOME、配置或日常Dev profile。 */
export async function runIsolatedTests(argv) {
  if (!argv.length) throw new Error("Usage: run-isolated-tests <command> [args...]");
  const testHome = await mkdtemp(join(tmpdir(), "mikiko-test-runtime-"));
  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    MIKIKO_DATA_BASE_DIR: testHome,
    GIT_CONFIG_GLOBAL: join(testHome, ".gitconfig"),
  };
  // 修复原因：CLI测试会经过真实插件发现与配置迁移；继承个人路径会改写日常缓存/数据库。
  // 路径显式测试仍可在本用例内注入；入口不能继承生产profile的覆盖项。
  for (const key of [
    "MIKIKO_STORAGE_DIR",
    "ZCODE_STORAGE_DIR",
    "MIKIKO_SESSION_DB_PATH",
    "ZCODE_SESSION_DB_PATH",
    "MIKIKO_SESSION_DB",
    "ZCODE_SESSION_DB",
    "ZCODE_DATA_BASE_DIR",
    "MIKIKO_HOME",
    "ZCODE_HOME",
    "MIKIKO_DESKTOP_HOME_DIR",
    "ZCODE_DESKTOP_HOME_DIR",
    "MIKIKO_LOG_DIR",
    "ZCODE_LOG_DIR",
    "MIKIKO_MAILBOX_ROOT",
    "ZCODE_MAILBOX_ROOT",
    "MIKIKO_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  ])
    delete env[key];
  let command = argv[0];
  let args = argv.slice(1);
  if (command === "node") command = process.execPath;
  else if (command === "vitest") {
    command = process.execPath;
    args = [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), ...args];
  } else if (command === "pnpm" && process.env.npm_execpath) {
    const entry = process.env.npm_execpath;
    command = /\.[cm]?js$/iu.test(entry) ? process.execPath : entry;
    if (command === process.execPath) args = [entry, ...args];
  }
  let child;
  let requestedSignal;
  const terminateTree = (signal) => {
    if (!child?.pid) return;
    if (process.platform === "win32") {
      // Windows没有POSIX进程组，taskkill在父进程尚存时回收其整棵测试进程树。
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.once("error", () => child.kill(signal));
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") child.kill(signal);
    }
  };
  const onInterrupt = () => {
    requestedSignal = "SIGINT";
    terminateTree("SIGINT");
  };
  const onTerminate = () => {
    requestedSignal = "SIGTERM";
    terminateTree("SIGTERM");
  };
  try {
    return await new Promise((resolveRun, rejectRun) => {
      // 不经过shell，Vitest过滤表达式中的 | / & 不会被Windows解释成命令。
      child = spawn(command, args, {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
      child.once("error", rejectRun);
      child.once("close", (code, signal) => {
        const cancellation = requestedSignal ?? signal;
        resolveRun(cancellation === "SIGINT" ? 130 : cancellation ? 143 : (code ?? 1));
      });
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    // 修复依据：只结束包装进程会留下Turbo/测试孙进程，随后继续写入已清理的HOME。
    if (process.platform !== "win32") terminateTree("SIGKILL");
    await rm(testHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runIsolatedTests(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
