import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { buildThemeSkinWallpaperDataUrl, THEME_SKIN_WALLPAPER_MAX_BYTES } from "@zcode/shared";

/**
 * 主题皮肤壁纸暂存/读取（specs/ui/theme-skins.md §5/§8）：
 * - stageWallpaperImage：编辑器选图先复制进 .staging（保存时转正，7 天 TTL 兜底清理）；
 * - readWallpaperDataUrl：一键配色取色用，只放行库内（含 staging）图片副本转 dataURL。
 * 从 desktopThemeSkinService 拆出以控制文件行数；文件 IO 依赖保持可注入。
 */

export const WALLPAPER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const STAGING_DIR_NAME = ".staging";

export interface ThemeSkinStagingDeps {
  /** 皮肤根目录（~/.mikiko/v2/theme-skins）。 */
  rootDir: () => string;
}

export function isInsideThemeSkinRoot(rootDir: () => string, dir: string): boolean {
  const root = resolve(rootDir());
  const target = resolve(dir);
  return target === root || target.startsWith(`${root}${sep}`);
}

export interface ThemeSkinStagingMethods {
  stageWallpaperImage(sourcePath: string): Promise<{ path?: string; error?: string }>;
  readWallpaperDataUrl(path: string): Promise<{ dataUrl?: string; error?: string }>;
}

export function createThemeSkinStagingMethods(deps: ThemeSkinStagingDeps): ThemeSkinStagingMethods {
  const stagingDir = () => join(deps.rootDir(), STAGING_DIR_NAME);
  return {
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

    async readWallpaperDataUrl(path) {
      try {
        const resolved = resolve(path);
        // 只放行库内（含 staging）的图片副本；一键配色取色不需要也不允许读任意文件。
        if (!isInsideThemeSkinRoot(deps.rootDir, resolved)) {
          return { error: "path outside theme skins root" };
        }
        const extension = resolved.slice(resolved.lastIndexOf(".") + 1).toLowerCase();
        if (!WALLPAPER_EXTENSIONS.has(extension)) {
          return { error: "wallpaper must be png/jpg/webp" };
        }
        const fileStat = await stat(resolved);
        if (!fileStat.isFile()) return { error: "wallpaper is not a file" };
        if (fileStat.size > THEME_SKIN_WALLPAPER_MAX_BYTES) {
          return { error: "wallpaper image too large" };
        }
        const bytes = new Uint8Array(await readFile(resolved));
        const mime =
          extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
        return { dataUrl: buildThemeSkinWallpaperDataUrl(mime, bytes) };
      } catch (error) {
        return { error: `read wallpaper failed: ${String(error)}` };
      }
    },
  };
}
