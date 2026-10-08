/**
 * 会话文件打开方式 —— UI 侧共享工具。
 *
 * - 修饰键+点击（macOS 用 Cmd+左键，Windows/Linux 用 Ctrl+左键）：与 MessageExternalLink
 *   外链的现行判定保持一致（metaKey || ctrlKey），平台间自然满足；
 * - 「默认应用打开」失败/能力缺失时静默回落既有点击链路（内置预览 → 预览侧栏的
 *   「不支持预览」占位），不额外弹错；
 * - 「格式应用 + 通用编辑器」按 id 去重保序合并，供「打开」菜单统一渲染。
 */

import { logger } from "@/logger.js";

interface OpenExternalFileCapablePlatform {
  openExternalFile?: (path: string) => Promise<{ success: boolean; error?: string }>;
}

export function isOpenWithDefaultAppModifierEvent(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.metaKey || event.ctrlKey;
}

/** 尝试用系统默认应用打开文件；成功返回 true，失败/无能力返回 false（调用方回落内置预览） */
export async function openFileWithDefaultApp(
  platform: OpenExternalFileCapablePlatform,
  path: string,
): Promise<boolean> {
  if (!platform.openExternalFile) {
    return false;
  }

  try {
    const result = await platform.openExternalFile(path);
    if (result.success) {
      return true;
    }
    logger.debug("[fileOpenMethods] 默认应用打开失败，回落内置预览", {
      path,
      error: result.error ?? "unknown-error",
    });
  } catch (error) {
    logger.debug("[fileOpenMethods] 默认应用打开异常，回落内置预览", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

/** 合并格式应用与通用编辑器：格式应用在前，编辑器中已出现过的 id 不再重复 */
export function mergeFileOpenApps<T extends { id: string }>(
  formatApps: readonly T[],
  editors: readonly T[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const app of [...formatApps, ...editors]) {
    if (seen.has(app.id)) {
      continue;
    }
    seen.add(app.id);
    merged.push(app);
  }
  return merged;
}
