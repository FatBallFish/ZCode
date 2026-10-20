import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
for (const separator of [false, true]) {
  test(`the complete CLI test graph accepts an explicit resource limit${separator ? " after pnpm's separator" : ""}`, async () => {
    // 实际调用 Turbo dry-run，回归重复 --concurrency 被 CLI 拒绝的问题，并验证所有入口仍在图内。
    const { stdout } = await exec(
      process.execPath,
      [
        join(import.meta.dirname, "run-tests.mjs"),
        ...(separator ? ["--"] : []),
        "--only",
        "--concurrency=1",
        "--dry=json",
      ],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    const tasks = new Set(report.tasks.map((task) => task.taskId));
    for (const owner of [
      "adapters",
      "bootstrap",
      "core",
      "cli",
      "tui",
      "office-runtime",
      "browser-use-plugin",
    ]) {
      assert.ok(tasks.has(`@zcode/${owner}#test`), `missing ${owner} test entry`);
    }
  });
}

for (const explicit of [false, true]) {
  test(`the subprocess receives one resource limit (${explicit ? "explicit" : "default"})`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "mikiko-test-wrapper-")));
    try {
      const scriptDirectory = join(root, "apps/zcode-cli/scripts");
      const turboDirectory = join(root, "node_modules/turbo/bin");
      await mkdir(scriptDirectory, { recursive: true });
      await mkdir(turboDirectory, { recursive: true });
      const runner = join(scriptDirectory, "run-tests.mjs");
      await copyFile(join(import.meta.dirname, "run-tests.mjs"), runner);
      await writeFile(
        join(turboDirectory, "turbo"),
        "process.stdout.write(JSON.stringify({ args:process.argv.slice(2),path:process.env.PATH,workers:process.env.VITEST_MAX_WORKERS }));",
      );
      const env = { ...process.env };
      delete env.VITEST_MAX_WORKERS;
      if (explicit) env.VITEST_MAX_WORKERS = "2";
      const { stdout } = await exec(
        process.execPath,
        [runner, ...(explicit ? ["--", "--concurrency=2"] : []), "--only"],
        { env },
      );
      const actual = JSON.parse(stdout);
      assert.deepEqual(
        actual.args.filter((arg) => arg.startsWith("--concurrency=")),
        [explicit ? "--concurrency=2" : "--concurrency=1"],
      );
      assert.ok(actual.args.includes("--only"));
      assert.equal(actual.args.includes("--"), false);
      assert.equal(actual.path.split(delimiter)[0], join(root, "node_modules/.bin"));
      assert.equal(actual.workers, explicit ? "2" : "1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
