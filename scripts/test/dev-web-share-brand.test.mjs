import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
for (const mode of ["test", "mock"]) {
  test(`share ${mode} starts only the configured self-hosted product origin`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mikiko-share-env-"));
    try {
      const resultFile = join(directory, "record.json");
      const recorder = join(directory, "recorder.cjs");
      await writeFile(
        recorder,
        'require("node:fs").writeFileSync(process.env.MIKIKO_SHARE_TEST_RECORD, JSON.stringify({ args: process.argv.slice(2), mode: process.env.MIKIKO_ENV, origin: process.env.VITE_MIKIKO_BASE_URL, mock: process.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK }));',
      );
      const command = join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
      await writeFile(
        command,
        process.platform === "win32"
          ? `@"${process.execPath}" "${recorder}" %*\r\n`
          : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`,
      );
      if (process.platform !== "win32") await chmod(command, 0o755);
      const child = spawnSync(process.execPath, [resolve("scripts/dev-web-share-env.mjs"), mode], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory + (process.platform === "win32" ? ";" : ":") + process.env.PATH,
          MIKIKO_SHARE_TEST_RECORD: resultFile,
        },
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(await readFile(resultFile, "utf8"));
      assert.equal(result.origin, "https://agent.mikiko.ai");
      assert.equal(result.mode, "test");
      assert.equal(result.mock, mode === "mock" ? "true" : "false");
      assert.ok(result.args.includes("@zcode/web-share"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
