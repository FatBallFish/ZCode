import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildThemeSkinWallpaperDataUrl } from "@zcode/shared";
import type { ThemeSkinRecord } from "@zcode/shared";

/**
 * 组装 .mikikotheme 导出文件（specs/ui/theme-skins.md §3）：theme.json 记录 →
 * 导出 JSON，图片壁纸内嵌 base64 dataURI。从 desktopThemeSkinService 拆出以控制文件行数。
 */
export async function buildThemeSkinExportJson(
  record: ThemeSkinRecord,
  skinDir: string,
): Promise<string> {
  let wallpaper: Record<string, unknown> | undefined;
  if (record.wallpaper?.kind === "css") {
    wallpaper = { ...record.wallpaper };
  } else if (record.wallpaper?.kind === "image") {
    const bytes = await readFile(join(skinDir, record.wallpaper.file));
    const extension = record.wallpaper.file.split(".").pop()?.toLowerCase();
    const mime =
      extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    const { file: _file, ...wallpaperCommon } = record.wallpaper;
    wallpaper = {
      ...wallpaperCommon,
      kind: "image",
      dataUrl: buildThemeSkinWallpaperDataUrl(mime, new Uint8Array(bytes)),
    };
  }
  const exportPayload = {
    format: "mikiko-theme-skin",
    formatVersion: 1,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    ...(record.author ? { author: record.author } : {}),
    version: record.version,
    light: record.light,
    dark: record.dark,
    ...(wallpaper ? { wallpaper } : {}),
  };
  return `${JSON.stringify(exportPayload, null, 2)}\n`;
}
