import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScope } from "../affected-unit-tests/scope.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function buildRepo() {
  const root = await mkdtemp(join(tmpdir(), "affected-scope-tagpush-"));
  const run = (cmd, args, opts = {}) => execFileAsync(cmd, args, { cwd: root, ...opts });
  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.email", "test@example.invalid"]);
  await run("git", ["config", "user.name", "affected-scope-test"]);
  await mkdir(join(root, "pkg"), { recursive: true });
  await writeFile(join(root, "pkg", "a.txt"), "one\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "base"]);
  const base = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "pkg", "a.txt"), "two\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "tip"]);
  const head = await git(root, "rev-parse", "HEAD");
  // 模拟 fork 形态：只有 main 远端（无 staging），HEAD 已在远端 main 之上。
  await run("git", ["remote", "add", "origin", root]);
  await run("git", ["update-ref", "refs/remotes/origin/main", base]);
  await run("git", ["branch", "--set-upstream-to=origin/main", "main"]);
  return { root, base, head };
}

const ZERO_40 = "0".repeat(40);

test("新 tag 推送（remote SHA 为零）在无 origin/staging 的仓库不再抛错", async () => {
  const { root, head } = await buildRepo();
  try {
    // 首选 staging 不存在 → 回退上游远端跟踪 origin/main（base），merge-base 可解析。
    const scope = await resolveScope(
      root,
      { scope: "push" },
      {
        ZCODE_PRE_PUSH_STDIN: `refs/tags/v9.9.9 ${head} refs/tags/v9.9.9 ${ZERO_40}\n`,
      },
    );
    assert.equal(scope.bases.length, 1);
    assert.match(scope.bases[0], /^[0-9a-f]{40}$/u);
    assert.notEqual(scope.bases[0], head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("补推历史 tag（非 HEAD）被跳过而不是报“推送目标不是当前 HEAD”", async () => {
  const { root, base } = await buildRepo();
  try {
    const scope = await resolveScope(
      root,
      { scope: "push" },
      {
        ZCODE_PRE_PUSH_STDIN: `refs/tags/v1.0.0 ${base} refs/tags/v1.0.0 ${ZERO_40}\n`,
      },
    );
    // 旧 tag 不引入新代码：范围内无基线，视同无选中测试。
    assert.equal(scope.bases.length, 0);
    assert.equal(scope.deletedOnly, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("分支推送语义不变：remote SHA 是基线，非 HEAD 目标仍拒绝", async () => {
  const { root, base, head } = await buildRepo();
  try {
    const scope = await resolveScope(
      root,
      { scope: "push" },
      { ZCODE_PRE_PUSH_STDIN: `refs/heads/main ${head} refs/heads/main ${base}\n` },
    );
    assert.deepEqual(scope.bases, [base]);

    await assert.rejects(
      () =>
        resolveScope(
          root,
          { scope: "push" },
          { ZCODE_PRE_PUSH_STDIN: `refs/heads/other ${base} refs/heads/other ${ZERO_40}\n` },
        ),
      /推送目标不是当前 HEAD/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
