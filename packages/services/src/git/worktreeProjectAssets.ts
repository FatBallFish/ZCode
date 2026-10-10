import { cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("worktree");

/**
 * 物化根项目未跟踪的 `.agents`（specs/desktop/worktrees.md「未跟踪项目资产物化」）：
 * `git worktree add` 只检出 git 跟踪文件，本地安装的项目级 skills
 * （`.agents/skills/*`，通常未跟踪）不会出现在新工作树；工作树又建在仓库外，
 * CLI 的技能根回溯也够不到原项目——用户实测工作树会话找不到项目级技能。
 * 递归拷贝（覆盖 git 检出的旧版本，工作树与根项目一致），best-effort：
 * 源不存在跳过、失败只 warn 不阻塞创建（git 侧已成功，技能缺失不应连坐整个工作树）。
 */
export async function copyRootAgentsDir(
  rootWorkspacePath: string,
  worktreePath: string,
): Promise<void> {
  const sourceDir = join(rootWorkspacePath, ".agents");
  try {
    const sourceInfo = await stat(sourceDir);
    if (!sourceInfo.isDirectory()) {
      return;
    }
    await cp(sourceDir, join(worktreePath, ".agents"), { recursive: true });
    log.info(undefined, "[Worktree] 已物化根项目 .agents", {
      rootWorkspacePath,
      worktreePath,
    });
  } catch (error) {
    log.warn(undefined, "[Worktree] .agents 物化失败（忽略）", {
      rootWorkspacePath,
      worktreePath,
      error,
    });
  }
}
