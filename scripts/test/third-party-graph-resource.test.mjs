import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { test } from "node:test";
import { readWorkspaceProductionGraph } from "../third-party-npm.mjs";

test("许可盘点依次读取锁图与实装图，不同时启动两个无界 pnpm ls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mikiko-notices-graph-"));
  const previousPath = process.env.PATH;
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const script = join(bin, "fake-pnpm.cjs");
    await writeFile(
      script,
      `
const fs = require('node:fs');
const path = require('node:path');
const active = path.join(process.cwd(), 'graph-active');
try { fs.writeFileSync(active, 'active', { flag: 'wx' }); }
catch { fs.writeFileSync(path.join(process.cwd(), 'overlap'), 'overlap'); process.exit(7); }
setTimeout(() => {
  fs.appendFileSync(path.join(process.cwd(), 'calls'), process.argv.includes('--lockfile-only') ? 'locked\\n' : 'installed\\n');
  fs.unlinkSync(active);
  process.stdout.write('[]');
}, 300);
`,
    );
    if (process.platform === "win32") {
      await writeFile(
        join(bin, "pnpm.cmd"),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
    } else {
      await writeFile(
        join(bin, "pnpm"),
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o755 },
      );
    }
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    const result = await readWorkspaceProductionGraph(directory);
    assert.equal(result.required.size, 0);
    assert.deepEqual(result.projects, []);
    assert.equal(await readFile(join(directory, "calls"), "utf8"), "locked\ninstalled\n");
    await assert.rejects(access(join(directory, "overlap")));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    // 失败分支里另一子进程可能还在收尾；等待其短暂持有结束后再清理本次目录。
    await new Promise((resolve) => setTimeout(resolve, 350));
    await rm(directory, { recursive: true, force: true });
  }
});
