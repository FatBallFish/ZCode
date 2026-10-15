import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  buildListItemFromRecord,
  clampThemeSkinWallpaperCommon,
  parseThemeSkinWallpaperDataUrl,
  themeSkinExportFileSchema,
  themeSkinRecordSchema,
  THEME_SKIN_EXPORT_FILE_MAX_BYTES,
  THEME_SKIN_ID_PATTERN,
  THEME_SKIN_NAME_MAX_LENGTH,
  THEME_SKIN_WALLPAPER_MAX_BYTES,
  validateThemeSkinTokenMap,
} from "@zcode/shared";
import type {
  ThemeSkinListItem,
  ThemeSkinRecord,
  ThemeSkinSavePayload,
  ThemeSkinWallpaper,
} from "@zcode/shared";
import { buildThemeSkinExportJson } from "./desktopThemeSkinExportFile.js";

/**
 * 主题皮肤存储服务（specs/ui/theme-skins.md §5）：管理 ~/.mikiko/v2/theme-skins 下的
 * 自定义/导入皮肤（theme.json + wallpaper.*）。内置皮肤不落盘（shared 常量）。
 * 文件 IO 全部依赖注入，可在 node:test 下脱离 Electron 覆盖；运行时只被 desktop main
 * 实例化，renderer 一律经 IPC 访问。写入走 mkdtemp 暂存 + rename 原子切换（同宠物 install）。
 */

const THEME_JSON_FILE = "theme.json";
const WALLPAPER_FILE_BASE = "wallpaper";
const WALLPAPER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const STAGING_DIR_NAME = ".staging";
/** 暂存壁纸超过 7 天未转正则清理（编辑器放弃保存的残留）。 */
const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ThemeSkinServiceDeps {
  /** 皮肤根目录（~/.mikiko/v2/theme-skins）。 */
  rootDir: () => string;
  now?: () => Date;
  logger?: {
    warn: (message: string, data?: unknown) => void;
    info?: (message: string, data?: unknown) => void;
  };
}

export interface ThemeSkinService {
  listInstalled(): ThemeSkinListItem[];
  installThemeFile(
    filePath: string,
  ): Promise<{ ok: true; item: ThemeSkinListItem } | { ok: false; error: string }>;
  saveCustomTheme(
    payload: ThemeSkinSavePayload,
  ): Promise<{ ok: true; item: ThemeSkinListItem } | { ok: false; error: string }>;
  deleteTheme(id: string): { ok: boolean; error?: string };
  readExportFile(id: string): Promise<{ json?: string; error?: string }>;
  /** 编辑器选图后先复制进暂存区（保存时转正；返回路径供 themepack:// 预览）。 */
  stageWallpaperImage(sourcePath: string): Promise<{ path?: string; error?: string }>;
  cleanupStaging(): Promise<void>;
}

function generateThemeSkinId(): string {
  return `user-${randomBytes(6).toString("hex")}`;
}

function wallpaperFileName(extension: string): string {
  return `${WALLPAPER_FILE_BASE}.${extension}`;
}

export function createThemeSkinService(deps: ThemeSkinServiceDeps): ThemeSkinService {
  const logWarn = (message: string, data?: unknown) => deps.logger?.warn(message, data);
  const now = deps.now ?? (() => new Date());
  const stagingDir = () => join(deps.rootDir(), STAGING_DIR_NAME);

  const isInsideRoot = (dir: string) => {
    const root = resolve(deps.rootDir());
    const target = resolve(dir);
    return target === root || target.startsWith(`${root}${sep}`);
  };

  const readRecordFromDir = (skinDir: string, expectedId?: string): ThemeSkinRecord | null => {
    const themeJsonPath = join(skinDir, THEME_JSON_FILE);
    if (!existsSync(themeJsonPath)) return null;
    try {
      const parsed = themeSkinRecordSchema.safeParse(
        JSON.parse(readFileSync(themeJsonPath, "utf8")),
      );
      if (!parsed.success || (expectedId && parsed.data.id !== expectedId)) return null;
      const record: ThemeSkinRecord = {
        format: "mikiko-theme-skin-record",
        formatVersion: 1,
        id: parsed.data.id,
        name: parsed.data.name,
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(parsed.data.author ? { author: parsed.data.author } : {}),
        version: parsed.data.version,
        createdAt: parsed.data.createdAt,
        updatedAt: parsed.data.updatedAt,
        light: parsed.data.light,
        dark: parsed.data.dark,
        ...(parsed.data.wallpaper
          ? { wallpaper: parsed.data.wallpaper as ThemeSkinWallpaper }
          : {}),
      };
      return record;
    } catch {
      return null;
    }
  };

  /** 暂存目录写完整文件后原子切换；已存在目录先备份，失败回滚（同宠物 install）。 */
  const commitSkinDir = async (
    targetDir: string,
    buildStaging: (stagingDir: string) => Promise<void>,
  ): Promise<void> => {
    await mkdir(deps.rootDir(), { recursive: true });
    const staging = await mkdtemp(join(tmpdir(), "mikiko-theme-skin-"));
    const backup = join(
      deps.rootDir(),
      `.${join(targetDir).split(sep).pop()}.backup-${Date.now()}`,
    );
    try {
      await buildStaging(staging);
      if (existsSync(targetDir)) await rename(targetDir, backup);
      try {
        await rename(staging, targetDir);
      } catch (error) {
        if (existsSync(backup) && !existsSync(targetDir)) await rename(backup, targetDir);
        throw error;
      }
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    listInstalled(): ThemeSkinListItem[] {
      const root = deps.rootDir();
      if (!existsSync(root)) return [];
      const result: ThemeSkinListItem[] = [];
      let entries: string[];
      try {
        entries = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
      for (const name of entries) {
        if (name.startsWith(".")) continue;
        const skinDir = join(root, name);
        const record = readRecordFromDir(skinDir, name);
        if (!record) {
          logWarn("[theme-skins] skip invalid skin directory", { dir: name });
          continue;
        }
        const item = buildListItemFromRecord(record, skinDir);
        // 防御：record 引用的壁纸文件丢失时降级为无壁纸主题（坏引用不该让缩略/运行态
        // 指向一个打不开的 themepack URL），并告警便于排查。
        if (item.wallpaperImagePath && !existsSync(item.wallpaperImagePath)) {
          logWarn("[theme-skins] wallpaper file missing; degrade to no wallpaper", {
            dir: name,
            file: item.wallpaper?.kind === "image" ? item.wallpaper.file : "",
          });
          delete item.wallpaperImagePath;
          delete item.wallpaper;
        }
        result.push(item);
      }
      result.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      return result;
    },

    async installThemeFile(filePath) {
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size > THEME_SKIN_EXPORT_FILE_MAX_BYTES) {
          return { ok: false, error: "file too large" };
        }
        const parsed = themeSkinExportFileSchema.safeParse(
          JSON.parse(await readFile(filePath, "utf8")),
        );
        if (!parsed.success) {
          return {
            ok: false,
            error: `invalid theme file: ${parsed.error.issues[0]?.message ?? "schema"}`,
          };
        }
        const skin = parsed.data;
        let wallpaper: ThemeSkinRecord["wallpaper"];
        let wallpaperBytes: Uint8Array | undefined;
        let wallpaperExtension: string | undefined;
        if (skin.wallpaper?.kind === "image") {
          const dataUrl = parseThemeSkinWallpaperDataUrl(skin.wallpaper.dataUrl);
          if (!dataUrl.ok) return { ok: false, error: dataUrl.error };
          if (dataUrl.bytes.byteLength > THEME_SKIN_WALLPAPER_MAX_BYTES) {
            return { ok: false, error: "wallpaper image too large" };
          }
          wallpaperBytes = dataUrl.bytes;
          wallpaperExtension = dataUrl.extension;
          wallpaper = {
            kind: "image",
            file: wallpaperFileName(wallpaperExtension),
            ...clampThemeSkinWallpaperCommon(skin.wallpaper),
          };
        } else if (skin.wallpaper?.kind === "css") {
          wallpaper = {
            ...skin.wallpaper,
            ...clampThemeSkinWallpaperCommon(skin.wallpaper),
          };
        }

        const id = generateThemeSkinId();
        const timestamp = now().toISOString();
        const record: ThemeSkinRecord = {
          format: "mikiko-theme-skin-record",
          formatVersion: 1,
          id,
          name: skin.name,
          ...(skin.description ? { description: skin.description } : {}),
          ...(skin.author ? { author: skin.author } : {}),
          version: skin.version ?? "1.0.0",
          createdAt: timestamp,
          updatedAt: timestamp,
          light: skin.light,
          dark: skin.dark,
          ...(wallpaper ? { wallpaper } : {}),
        };
        const targetDir = join(deps.rootDir(), id);
        await commitSkinDir(targetDir, async (staging) => {
          await writeFile(join(staging, THEME_JSON_FILE), `${JSON.stringify(record, null, 2)}\n`);
          if (wallpaperBytes && wallpaperExtension) {
            await writeFile(join(staging, wallpaperFileName(wallpaperExtension)), wallpaperBytes);
          }
        });
        deps.logger?.info?.("[theme-skins] imported", { id, name: skin.name });
        return { ok: true, item: buildListItemFromRecord(record, targetDir) };
      } catch (error) {
        logWarn("[theme-skins] import failed", {
          filePath,
          error: String(error),
        });
        return { ok: false, error: `import failed: ${String(error)}` };
      }
    },

    async saveCustomTheme(payload) {
      const name = payload.name.trim();
      if (name.length === 0 || name.length > THEME_SKIN_NAME_MAX_LENGTH) {
        return { ok: false, error: "invalid name" };
      }
      const lightCheck = validateThemeSkinTokenMap(payload.light);
      if (!lightCheck.ok) return { ok: false, error: `light tokens: ${lightCheck.error}` };
      const darkCheck = validateThemeSkinTokenMap(payload.dark);
      if (!darkCheck.ok) return { ok: false, error: `dark tokens: ${darkCheck.error}` };

      const id =
        payload.id && THEME_SKIN_ID_PATTERN.test(payload.id) && !payload.id.startsWith(".")
          ? payload.id
          : generateThemeSkinId();
      const targetDir = join(deps.rootDir(), id);
      if (!isInsideRoot(targetDir)) return { ok: false, error: "invalid skin id" };
      const previous = existsSync(targetDir) ? readRecordFromDir(targetDir, id) : null;

      const common = clampThemeSkinWallpaperCommon(payload.wallpaper);
      let wallpaper: ThemeSkinRecord["wallpaper"];
      let copyWallpaperFrom: string | undefined;
      let copyWallpaperTo: string | undefined;
      if (payload.wallpaper.mode === "css") {
        wallpaper = { kind: "css", css: payload.wallpaper.css, ...common };
      } else if (payload.wallpaper.mode === "image") {
        const staged = resolve(payload.wallpaper.stagedPath);
        if (!staged.startsWith(`${resolve(stagingDir())}${sep}`)) {
          return {
            ok: false,
            error: "wallpaper staging path is outside the staging directory",
          };
        }
        const extension = staged.split(".").pop()?.toLowerCase() ?? "";
        if (!WALLPAPER_EXTENSIONS.has(extension)) {
          return { ok: false, error: "wallpaper extension not allowed" };
        }
        copyWallpaperFrom = staged;
        copyWallpaperTo = wallpaperFileName(extension);
        wallpaper = { kind: "image", file: copyWallpaperTo, ...common };
      } else if (payload.wallpaper.mode === "keep-image" && previous?.wallpaper) {
        // 保留上一版壁纸（图片沿用文件；css 沿用表达式），只更新公共参数。
        // 修复原因（2026-10-15）：commitSkinDir 是整目录暂存替换，keep-image 若不把
        // 旧壁纸文件复制进暂存目录，原子切换后壁纸文件会直接丢失（用户实测触发）。
        wallpaper =
          previous.wallpaper.kind === "image"
            ? { kind: "image", file: previous.wallpaper.file, ...common }
            : { kind: "css", css: previous.wallpaper.css, ...common };
        if (wallpaper.kind === "image") {
          const previousWallpaperPath = join(targetDir, wallpaper.file);
          if (!existsSync(previousWallpaperPath)) {
            return { ok: false, error: "previous wallpaper file is missing" };
          }
          copyWallpaperFrom = previousWallpaperPath;
          copyWallpaperTo = wallpaper.file;
        }
      }

      const timestamp = now().toISOString();
      const record: ThemeSkinRecord = {
        format: "mikiko-theme-skin-record",
        formatVersion: 1,
        id,
        name,
        ...(payload.description?.trim()
          ? { description: payload.description.trim() }
          : previous?.description
            ? { description: previous.description }
            : {}),
        ...(previous?.author ? { author: previous.author } : {}),
        version: previous?.version ?? "1.0.0",
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        light: payload.light,
        dark: payload.dark,
        ...(wallpaper ? { wallpaper } : {}),
      };

      try {
        await commitSkinDir(targetDir, async (staging) => {
          await writeFile(join(staging, THEME_JSON_FILE), `${JSON.stringify(record, null, 2)}\n`);
          if (copyWallpaperFrom && copyWallpaperTo) {
            await copyFile(copyWallpaperFrom, join(staging, copyWallpaperTo));
          }
        });
        deps.logger?.info?.("[theme-skins] saved", { id, name });
        return { ok: true, item: buildListItemFromRecord(record, targetDir) };
      } catch (error) {
        logWarn("[theme-skins] save failed", { id, error: String(error) });
        return { ok: false, error: `save failed: ${String(error)}` };
      }
    },

    deleteTheme(id) {
      if (!THEME_SKIN_ID_PATTERN.test(id) || id.startsWith(".")) {
        return { ok: false, error: "invalid skin id" };
      }
      const targetDir = join(deps.rootDir(), id);
      if (!isInsideRoot(targetDir)) return { ok: false, error: "invalid skin id" };
      if (!existsSync(targetDir)) return { ok: false, error: "not installed" };
      try {
        rmSync(targetDir, { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    async readExportFile(id) {
      if (!THEME_SKIN_ID_PATTERN.test(id) || id.startsWith(".")) {
        return { error: "invalid skin id" };
      }
      const skinDir = join(deps.rootDir(), id);
      const record = readRecordFromDir(skinDir, id);
      if (!record) return { error: "not installed" };
      try {
        return { json: await buildThemeSkinExportJson(record, skinDir) };
      } catch (error) {
        return { error: `export read failed: ${String(error)}` };
      }
    },

    async stageWallpaperImage(sourcePath) {
      try {
        const extension = sourcePath.split(".").pop()?.toLowerCase() ?? "";
        if (!WALLPAPER_EXTENSIONS.has(extension)) {
          return { error: "wallpaper must be png/jpg/webp" };
        }
        const fileStat = await stat(sourcePath);
        if (!fileStat.isFile()) return { error: "wallpaper source is not a file" };
        if (fileStat.size > THEME_SKIN_WALLPAPER_MAX_BYTES) {
          return { error: "wallpaper image too large" };
        }
        await mkdir(stagingDir(), { recursive: true });
        const stagedPath = join(stagingDir(), `${randomBytes(8).toString("hex")}.${extension}`);
        await copyFile(sourcePath, stagedPath);
        return { path: stagedPath };
      } catch (error) {
        return { error: `stage wallpaper failed: ${String(error)}` };
      }
    },

    async cleanupStaging() {
      const staging = stagingDir();
      if (!existsSync(staging)) return;
      try {
        const entries = await readdir(staging, { withFileTypes: true });
        const expireBefore = now().getTime() - STAGING_MAX_AGE_MS;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = join(staging, entry.name);
          try {
            const fileStat = await stat(filePath);
            if (fileStat.mtimeMs < expireBefore) {
              await rm(filePath, { force: true });
            }
          } catch {
            // 单个文件清理失败跳过，不影响其余。
          }
        }
      } catch {
        // 清理尽力而为。
      }
    },
  };
}
