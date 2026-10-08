import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isWebp, normalizePetManifest, type InstalledPetInfo } from "@zcode/shared";

/**
 * 本地宠物包扫描与安装记录 IO（specs/desktop/desktop-pet.md）。
 * 从 desktopPetMarketService 拆出：这里只回答「磁盘上已有什么、是否可信」，不碰网络。
 */

export const INSTALL_RECORD_FILE = ".install.json";
export const PET_MANIFEST_FILE = "pet.json";
export const PET_SHEET_FILE = "spritesheet.webp";
/** 目标目录里允许出现的文件；出现其它文件（或符号链接）时拒绝覆盖安装。 */
export const ALLOWED_TARGET_FILES = new Set([
  PET_MANIFEST_FILE,
  PET_SHEET_FILE,
  "submission.json",
  INSTALL_RECORD_FILE,
]);

export interface InstalledPetRecord {
  installedFrom: "market" | "codex-import" | "builtin";
  installedAt: string;
  petJsonSha256: string;
  spritesheetSha256: string;
  spriteVersionNumber: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readInstalledRecord(petDir: string): InstalledPetRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(petDir, INSTALL_RECORD_FILE), "utf8")) as
      | InstalledPetRecord
      | { installedFrom?: string };
    if (
      raw &&
      (raw.installedFrom === "market" ||
        raw.installedFrom === "codex-import" ||
        raw.installedFrom === "builtin") &&
      typeof raw.petJsonSha256 === "string" &&
      typeof raw.spritesheetSha256 === "string"
    ) {
      return raw as InstalledPetRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 本地目录内一只已安装宠物 → 运行时信息；清单非法的目录返回 undefined（扫描时跳过）。 */
export function loadInstalledPetFromDir(
  petDir: string,
  petId: string,
  readImageSize: (bytes: Uint8Array) => { width: number; height: number },
): { info: InstalledPetInfo; petJsonSha256: string; spritesheetSha256: string } | undefined {
  const manifestPath = join(petDir, PET_MANIFEST_FILE);
  if (!existsSync(manifestPath) || !existsSync(join(petDir, PET_SHEET_FILE))) {
    return undefined;
  }
  try {
    const petJsonBytes = readFileSync(manifestPath);
    const sheetBytes = readFileSync(join(petDir, PET_SHEET_FILE));
    if (!isWebp(sheetBytes)) return undefined;
    const size = readImageSize(sheetBytes);
    const manifest = JSON.parse(petJsonBytes.toString("utf8"));
    const normalized = normalizePetManifest({
      manifest,
      fallbackId: petId,
      sheetWidth: size.width,
      sheetHeight: size.height,
    });
    if (!normalized.ok) return undefined;
    const record = readInstalledRecord(petDir);
    return {
      info: {
        id: normalized.pet.id,
        displayName: normalized.pet.displayName,
        description: normalized.pet.description,
        spriteVersionNumber: record?.spriteVersionNumber ?? (normalized.pet.rows === 11 ? 2 : 1),
        installedFrom: record?.installedFrom ?? "codex-import",
        installedAt: record?.installedAt ?? "",
        petJsonSha256: record?.petJsonSha256 ?? sha256Hex(petJsonBytes),
        spritesheetSha256: record?.spritesheetSha256 ?? sha256Hex(sheetBytes),
      },
      petJsonSha256: sha256Hex(petJsonBytes),
      spritesheetSha256: sha256Hex(sheetBytes),
    };
  } catch {
    return undefined;
  }
}

/** 目录含符号链接或白名单之外的条目时为 true（覆盖安装/卸载都应拒绝）。目录消失按 true 处理。 */
export function directoryContainsSymlinkOrExtraFiles(petDir: string): boolean {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(petDir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !ALLOWED_TARGET_FILES.has(entry.name)) return true;
  }
  return false;
}
