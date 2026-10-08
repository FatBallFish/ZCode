/**
 * 格式感知的文件打开应用 —— 检测、解析与缓存（main 进程）。
 *
 * 规则表见 fileOpenAppConfig.ts（纯配置）；应用安装检测复用 editors.ts 的
 * existsSync + icns 图标链路，结果按应用 id 在应用生命周期内缓存。
 * appIds 可同时指向格式应用 defs 与平台编辑器 defs，id 漂移时静默跳过。
 */

import { readdirSync } from "node:fs";
import { extname, win32 as pathWin32 } from "node:path";
import type { EditorInfo } from "@zcode/shared";
import {
  getAppIconDataUrl,
  getEditorDefsForCurrentPlatform,
  resolveEditorDefAppPath,
  type EditorDef,
} from "./editors.js";
import {
  FILE_OPEN_APP_DEFS,
  resolveFileOpenAppIdsForExtension,
  type FileOpenAppDef,
} from "./fileOpenAppConfig.js";
import { logger } from "./logger.js";

type OpenableAppDef = EditorDef | FileOpenAppDef;

const cachedFileAppInfos = new Map<string, EditorInfo | null>();

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Windows 侧版本化安装目录扫描：静态候选路径覆盖不到（WPS 版本目录、Adobe 年份目录） */
function scanWindowsVersionedCandidates(
  rootDir: string,
  dirPrefix: string,
  exeSegments: string[],
): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const entries = readdirSync(rootDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.toLowerCase().startsWith(dirPrefix.toLowerCase()),
      )
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
    return entries.map((entry) => pathWin32.join(rootDir, entry, ...exeSegments));
  } catch {
    // 可选安装目录不存在是常态，静默跳过。
    return [];
  }
}

function collectWindowsScannedCandidates(appId: string): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  switch (appId) {
    case "wps": {
      const localAppData = process.env.LOCALAPPDATA;
      return localAppData
        ? scanWindowsVersionedCandidates(
            pathWin32.join(localAppData, "Kingsoft", "WPS Office"),
            "",
            ["office6", "wpsoffice.exe"],
          )
        : [];
    }
    case "adobe-photoshop":
    case "adobe-acrobat": {
      const exeSegments =
        appId === "adobe-acrobat" ? ["Acrobat", "Acrobat.exe"] : ["Photoshop.exe"];
      const dirPrefix = appId === "adobe-acrobat" ? "Adobe Acrobat" : "Adobe Photoshop";
      const systemDrive = process.env.SystemDrive || "C:";
      const roots = Array.from(
        new Set(
          [
            process.env.ProgramFiles,
            process.env["ProgramFiles(x86)"],
            `${systemDrive}\\Program Files`,
            `${systemDrive}\\Program Files (x86)`,
          ].filter((root): root is string => typeof root === "string" && root.length > 0),
        ),
      );
      return roots.flatMap((root) =>
        scanWindowsVersionedCandidates(pathWin32.join(root, "Adobe"), dirPrefix, exeSegments),
      );
    }
    default:
      return [];
  }
}

/** 查找格式应用 def（合并 Windows 扫描出的动态候选路径）；找不到返回 undefined */
export function findFileOpenAppDef(appId: string): FileOpenAppDef | undefined {
  const def = FILE_OPEN_APP_DEFS.find((entry) => entry.id === appId);
  if (!def) {
    return undefined;
  }

  const scanned = collectWindowsScannedCandidates(appId);
  return scanned.length > 0
    ? { ...def, appPathCandidates: [...(def.appPathCandidates ?? []), ...scanned] }
    : def;
}

/** 统一的应用 id → def 查找：平台编辑器 defs 优先，格式应用 defs 兜底 */
export function findOpenableAppDef(appId: string): OpenableAppDef | undefined {
  return (
    getEditorDefsForCurrentPlatform().find((entry) => entry.id === appId) ??
    findFileOpenAppDef(appId)
  );
}

async function resolveFileOpenAppInfo(appId: string): Promise<EditorInfo | null> {
  if (cachedFileAppInfos.has(appId)) {
    return cachedFileAppInfos.get(appId) ?? null;
  }

  let info: EditorInfo | null = null;
  try {
    const def = findOpenableAppDef(appId);
    if (def) {
      const appPath = resolveEditorDefAppPath(def) ?? null;
      if (appPath) {
        const iconDataUrl = await getAppIconDataUrl(appId, appPath);
        if (iconDataUrl) {
          info = { id: def.id, name: def.name, iconDataUrl };
        }
      }
    }
    if (!info) {
      logger.info("[fileOpenApps] 应用未安装或图标缺失，跳过", { appId });
    }
  } catch (error) {
    logger.warn("[fileOpenApps] 解析格式应用失败", {
      appId,
      error: stringifyError(error),
    });
  }

  cachedFileAppInfos.set(appId, info);
  return info;
}

/**
 * 获取与指定文件格式匹配的已安装应用（文档/媒体/Adobe/IDE，含图标，按规则表顺序）。
 * Linux 与未知扩展返回空列表。
 */
export async function getInstalledAppsForFile(path: string): Promise<EditorInfo[]> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return [];
  }

  const appIds = resolveFileOpenAppIdsForExtension(extname(path));
  const results: EditorInfo[] = [];
  for (const appId of appIds) {
    const info = await resolveFileOpenAppInfo(appId);
    if (info) {
      results.push(info);
    }
  }
  return results;
}
