import { resolve } from "node:path";
import { git, run } from "./process.mjs";

async function commit(root, ref) {
  try {
    return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]))
      .toString()
      .trim();
  } catch (error) {
    throw new Error(`无法解析基线或提交 ${ref}：${error.message}`, { cause: error });
  }
}
async function isAncestor(root, ancestor, head) {
  const check = await run("git", ["merge-base", "--is-ancestor", ancestor, head], {
    allowFailure: true,
  });
  return check.code === 0;
}

// rebase / force-push 后远端 SHA 不再是 HEAD 的祖先；直接拿它当基线会让 Vitest
// 找不到公共祖先而退化成全量选择。回退到双方 merge-base，永远给官方选择一个
// 真实分叉点（最坏也只是比严格推送范围多选 staging 侧的新增改动，不会全量）。
async function resolvePushBase(root, head, remote) {
  if (await isAncestor(root, remote, head)) {
    return remote;
  }

  return (await git(root, ["merge-base", remote, head])).toString().trim();
}

async function firstPushBase(root, head) {
  // 首次推送（新分支/新 tag）没有 remote SHA。优先上游集成分支 origin/staging；
  // fork/独立仓库没有 staging 时回退当前分支的远端跟踪与远端默认分支——
  // 2026-10-22 事故：v1.1.5 tag 推送因 staging 缺失被 pre-push 整体阻塞。
  // 全部候选缺失时仍严格报错，不猜测任意分支。
  const upstream = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: root, allowFailure: true },
  );
  const candidates = ["origin/staging"];
  if (upstream.code === 0) {
    const tracking = upstream.stdout.toString().trim();
    const originRef = tracking.startsWith("origin/")
      ? tracking
      : `origin/${tracking.replace(/^[^/]+\//u, "")}`;
    candidates.push(originRef);
  }
  candidates.push("origin/main", "origin/master", "main", "master");
  for (const candidate of candidates) {
    const check = await run("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
      cwd: root,
      allowFailure: true,
    });
    if (check.code === 0) {
      const base = check.stdout.toString().trim();
      return (await git(root, ["merge-base", base, head])).toString().trim();
    }
  }
  throw new Error("无法确定首次推送基线：origin/staging、上游远端跟踪与远端默认分支均不存在");
}

/** 只解析比较基线；改动文件与关联测试全部由 Vitest 官方选择。 */
export async function resolveScope(root, options = {}, env = process.env) {
  if (options.scope && !["worktree", "push"].includes(options.scope))
    throw new Error(`未知范围：${options.scope}`);
  const explicit = options.base ?? env.ZCODE_AFFECTED_TEST_BASE ?? env.ZCODE_PRE_PUSH_BASE;
  if (options.files && (options.scope === "push" || explicit))
    throw new Error("--files 不能与 push 或 --base 混用");
  if (options.files)
    return { files: [...new Set(options.files.map((file) => resolve(root, file)))], bases: [true] };
  if (options.scope !== "push") return { bases: [explicit ? await commit(root, explicit) : true] };

  // 脏工作区会让未提交代码掩盖推送版本的失败；先阻止，不自动 stash 或改写 index。
  if ((await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
    throw new Error("Push 工作区不干净：请先提交或自行保存已暂存、未暂存及未跟踪改动");
  const head = await commit(root, "HEAD");
  const entries = (env.ZCODE_PRE_PUSH_STDIN ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split(/\s+/u));
  const bases = [];
  if (entries.length) {
    for (const entry of entries) {
      if (entry.length !== 4 || !/^[\da-f]+$/iu.test(entry[1]) || !/^[\da-f]+$/iu.test(entry[3]))
        throw new Error("推送 ref 输入无效");
      if (/^0+$/u.test(entry[1])) continue;
      // HEAD 一致性只约束分支推送；补推/重推历史 tag 是合法操作，不引入新代码，
      // 直接跳过（范围内无变更），否则会在 tag 指向非 HEAD 提交时误伤发布流程。
      if ((await commit(root, entry[1])) !== head) {
        if (entry[0].startsWith("refs/tags/")) continue;
        throw new Error("推送目标不是当前 HEAD");
      }
      // hook 曾直接使用 remote SHA，导致显式基线变量失效；校验目标后优先使用调用方指定基线。
      bases.push(
        explicit
          ? await commit(root, explicit)
          : /^0+$/u.test(entry[3])
            ? await firstPushBase(root, head)
            : await resolvePushBase(root, head, await commit(root, entry[3])),
      );
    }
    return { bases: [...new Set(bases)], deletedOnly: !bases.length };
  }
  if (explicit) return { bases: [await commit(root, explicit)] };
  const upstream = await run("git", ["rev-parse", "--verify", "@{upstream}^{commit}"], {
    cwd: root,
    allowFailure: true,
  });
  return {
    bases: [
      upstream.code === 0
        ? await resolvePushBase(root, head, upstream.stdout.toString().trim())
        : await firstPushBase(root, head),
    ],
  };
}
