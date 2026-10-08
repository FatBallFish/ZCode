/**
 * Worktree 注册表（~/.mikiko/v2/worktrees.json）。
 *
 * 单一写入者：WorktreeService（本模块只提供 load/save 原语 + 串行队列）。
 * 损坏文件隔离为 .corrupt-<ts> 后从空表启动（settingService 同款策略）；
 * 磁盘 git 真值以 `git worktree list` 为准，注册表条目缺失时由服务层对账标记。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getAppConfigDir } from "#src/paths.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { worktreeRegistryEntrySchema, type WorktreeRegistryEntry } from "@zcode/shared";

const registryFileSchema = z.object({
  version: z.literal(1),
  worktrees: z.array(worktreeRegistryEntrySchema),
});

interface RegistryFile {
  version: 1;
  worktrees: WorktreeRegistryEntry[];
}

export function getWorktreeRegistryPath(): string {
  return join(getAppConfigDir(), "worktrees.json");
}

/** 生成 8 位随机 hex id（目录名）；展示用前 4 位。 */
export function generateWorktreeId(): string {
  return randomBytes(4).toString("hex");
}

function createEmptyRegistry(): RegistryFile {
  return { version: 1, worktrees: [] };
}

export interface WorktreeRegistry {
  load(): Promise<WorktreeRegistryEntry[]>;
  save(entries: WorktreeRegistryEntry[]): Promise<void>;
  /** 串行执行 mutate（读-改-写），返回 mutate 的返回值。 */
  mutate<T>(mutate: (entries: WorktreeRegistryEntry[]) => T | Promise<T>): Promise<T>;
}

export function createWorktreeRegistry(options?: { filePath?: string }): WorktreeRegistry {
  const filePath = options?.filePath ?? getWorktreeRegistryPath();
  // 写队列：并发的 create/remove 自动串行，避免读-改-写丢失更新。
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function loadFile(): Promise<RegistryFile> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyRegistry();
      }
      throw error;
    }
    try {
      return registryFileSchema.parse(JSON.parse(raw));
    } catch {
      // 损坏文件隔离后从空表启动；磁盘 worktree 仍在，服务层对账时能发现并提示。
      const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
      try {
        await rename(filePath, quarantinePath);
      } catch {
        // 隔离失败（如只读卷）不阻塞启动。
      }
      return createEmptyRegistry();
    }
  }

  async function persist(registry: RegistryFile): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteText(filePath, JSON.stringify(registry, null, 2));
  }

  return {
    async load(): Promise<WorktreeRegistryEntry[]> {
      return (await loadFile()).worktrees;
    },

    async save(entries: WorktreeRegistryEntry[]): Promise<void> {
      await persist({ version: 1, worktrees: entries });
    },

    mutate<T>(mutate: (entries: WorktreeRegistryEntry[]) => T | Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const registry = await loadFile();
        const result = await mutate(registry.worktrees);
        await persist({ version: 1, worktrees: registry.worktrees });
        return result;
      };
      const next = writeQueue.then(run, run);
      writeQueue = next.catch(() => undefined);
      return next;
    },
  };
}

// 供单测直接校验落盘内容。
export async function readRegistryFileForTest(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
