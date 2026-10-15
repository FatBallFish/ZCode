import { dialog, ipcMain } from "electron";
import { PlatformChannels, THEME_SKIN_NAME_MAX_LENGTH } from "@zcode/shared";
import type { ThemeSkinSavePayload } from "@zcode/shared";
import type { ThemeSkinService } from "./desktopThemeSkinService.js";

/**
 * 主题皮肤 IPC（specs/ui/theme-skins.md §5；设置页 ↔ main）。
 * 文件对话框与磁盘 IO 只在 main 侧；renderer 经 platform service 调用。
 * 对话框取消统一以 error === "canceled" 返回，UI 静默处理。
 */
export function registerThemeSkinIpc(options: { service: ThemeSkinService }): void {
  ipcMain.handle(PlatformChannels.ThemeSkinListInstalled, () => options.service.listInstalled());

  ipcMain.handle(PlatformChannels.ThemeSkinImportFromFile, async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Mikiko Theme", extensions: ["mikikotheme", "json"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: "canceled" };
    return options.service.installThemeFile(picked.filePaths[0]!);
  });

  ipcMain.handle(PlatformChannels.ThemeSkinSaveCustom, (_event, payload?: ThemeSkinSavePayload) => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.name !== "string" ||
      payload.name.trim().length === 0 ||
      payload.name.trim().length > THEME_SKIN_NAME_MAX_LENGTH ||
      typeof payload.light !== "object" ||
      typeof payload.dark !== "object" ||
      typeof payload.wallpaper !== "object" ||
      typeof payload.wallpaper.mode !== "string"
    ) {
      return { ok: false, error: "invalid request" };
    }
    return options.service.saveCustomTheme(payload);
  });

  ipcMain.handle(PlatformChannels.ThemeSkinDelete, (_event, payload?: { id: string }) => {
    if (typeof payload?.id !== "string") return { ok: false, error: "invalid request" };
    return options.service.deleteTheme(payload.id);
  });

  ipcMain.handle(PlatformChannels.ThemeSkinReadExportFile, (_event, payload?: { id: string }) => {
    if (typeof payload?.id !== "string") return { error: "invalid request" };
    return options.service.readExportFile(payload.id);
  });

  ipcMain.handle(PlatformChannels.ThemeSkinStageWallpaperImage, async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true };
    }
    return options.service.stageWallpaperImage(picked.filePaths[0]!);
  });
}
