/**
 * git worktree 底层命令封装（specs/desktop/worktrees.md）。
 *
 * 只做纯 git plumbing：add --detach / list --porcelain / remove / prune /
 * fetch / 远程默认分支解析 / 工作树脏文件计数。编排（注册表、自动清理、
 * 会话关联、进程存活校验）在 worktreeService.ts，不在本层。
 *
 * 语义对齐 Codex：创建即 detached HEAD；分支名留给后续显式创建（codex/<slug>）。
 */
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

const log = createServiceLogger("git-worktree-repo");

export interface GitWorktreeListEntry {
  /** 工作树绝对路径（已 normalize）。 */
  path: string;
  head: string;
  /** 形如 refs/heads/main；detached（bare/worktree add --detach）时为 null。 */
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export interface GitWorktreeRepo {
  /** `git worktree list --porcelain`；解析失败的单条目跳过并 warn。 */
  listWorktrees(repoRoot: string): Promise<GitWorktreeListEntry[]>;
  /** `git worktree add --detach <path> <ref>`；失败时抛带 git stderr 的 Error。 */
  addDetachedWorktree(repoRoot: string, worktreePath: string, ref: string): Promise<void>;
  /**
   * `git worktree remove [--force]`。
   * 脏树未带 force 时 git 返回非零，这里原样抛出，由上层转成 blockReason="dirty"。
   */
  removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<void>;
  /** `git worktree prune`；删除后兜底清理 .git/worktrees 残留元数据。 */
  pruneWorktrees(repoRoot: string): Promise<void>;
  /** `git fetch --prune <remote>`；无 remote 返回 false（静默跳过），失败抛错。 */
  fetchRemote(repoRoot: string): Promise<boolean>;
  /** 远程默认分支（形如 origin/main）；无法解析时返回 null。 */
  resolveRemoteDefaultBranch(repoRoot: string): Promise<string | null>;
  /** 工作树 porcelain 脏文件数（含 untracked）；路径不存在返回 null。 */
  getWorktreeDirtyFileCount(worktreePath: string): Promise<number | null>;
  /** detached HEAD 的短 SHA（展示用）；失败返回 null。 */
  getWorktreeHeadShortSha(worktreePath: string): Promise<string | null>;
}

export function createGitWorktreeRepo(options: {
  commandProvider: GitCommandProvider;
}): GitWorktreeRepo {
  const { commandProvider } = options;

  async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await commandProvider.run({
      cwd,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded(`git ${args[0]}`, result);
    return result.stdout;
  }

  function parseWorktreeListPorcelain(stdout: string): GitWorktreeListEntry[] {
    const entries: GitWorktreeListEntry[] = [];
    // porcelain 格式：条目间空行分隔；字段以行首关键词 + 空格开头（bare/detached 无值）。
    let current: Partial<GitWorktreeListEntry> | null = null;
    const flush = () => {
      if (current?.path) {
        entries.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
          bare: current.bare ?? false,
          detached: current.detached ?? false,
        });
      } else if (current) {
        log.warn(undefined, "[GitWorktreeRepo] worktree list 条目缺少 path，跳过");
      }
      current = null;
    };
    for (const rawLine of stdout.split(/\r?\n/)) {
      if (rawLine.length === 0) {
        flush();
        continue;
      }
      if (rawLine.startsWith("worktree ")) {
        flush();
        current = { path: rawLine.slice("worktree ".length) };
      } else if (rawLine.startsWith("HEAD ")) {
        if (current) current.head = rawLine.slice("HEAD ".length);
      } else if (rawLine.startsWith("branch ")) {
        if (current) current.branch = rawLine.slice("branch ".length);
      } else if (rawLine === "bare") {
        if (current) current.bare = true;
      } else if (rawLine === "detached") {
        if (current) current.detached = true;
      }
    }
    flush();
    return entries;
  }

  return {
    async listWorktrees(repoRoot: string): Promise<GitWorktreeListEntry[]> {
      const stdout = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
      return parseWorktreeListPorcelain(stdout);
    },

    async addDetachedWorktree(repoRoot: string, worktreePath: string, ref: string): Promise<void> {
      await runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, ref]);
    },

    async removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<void> {
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(worktreePath);
      await runGit(repoRoot, args);
    },

    async pruneWorktrees(repoRoot: string): Promise<void> {
      await runGit(repoRoot, ["worktree", "prune"]);
    },

    async fetchRemote(repoRoot: string): Promise<boolean> {
      const remotesStdout = await runGit(repoRoot, ["remote"]);
      const remotes = remotesStdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const primaryRemote = remotes[0];
      if (!primaryRemote) {
        return false;
      }
      await runGit(repoRoot, ["fetch", "--prune", primaryRemote]);
      return true;
    },

    async resolveRemoteDefaultBranch(repoRoot: string): Promise<string | null> {
      const remotesStdout = await runGit(repoRoot, ["remote"]);
      const remote = remotesStdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (!remote) {
        return null;
      }
      // 首选 symbolic-ref（本地已展开 origin/HEAD）；失败回退探测常见默认分支名。
      const symbolicResult = await commandProvider.run({
        cwd: repoRoot,
        args: ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (symbolicResult.exitCode === 0) {
        const value = symbolicResult.stdout.trim();
        if (value.length > 0) {
          return value;
        }
      }
      for (const candidate of [`${remote}/main`, `${remote}/master`]) {
        const probe = await commandProvider.run({
          cwd: repoRoot,
          args: ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        });
        if (probe.exitCode === 0) {
          return candidate;
        }
      }
      return null;
    },

    async getWorktreeDirtyFileCount(worktreePath: string): Promise<number | null> {
      const result = await commandProvider.run({
        cwd: worktreePath,
        args: ["status", "--porcelain"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        // 目录被外部删除等场景：返回 null 让上层标记 missing，而不是误报"干净"。
        return null;
      }
      return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    },

    async getWorktreeHeadShortSha(worktreePath: string): Promise<string | null> {
      const result = await commandProvider.run({
        cwd: worktreePath,
        args: ["rev-parse", "--short", "HEAD"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        return null;
      }
      return result.stdout.trim() || null;
    },
  };
}
