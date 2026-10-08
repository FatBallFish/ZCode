import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { PetMarketService } from "./desktopPetMarketService.js";

/**
 * 宠物市场 IPC（设置页 ↔ main；specs/desktop/desktop-pet.md）。
 * 网络与文件 IO 只在 main 侧发生；renderer 经 platform service 调用。
 */
export function registerPetMarketIpc(options: { market: PetMarketService }): void {
  ipcMain.handle(PlatformChannels.PetListInstalled, () => options.market.listInstalled());
  ipcMain.handle(PlatformChannels.PetMarketGetCatalog, (_event, payload?: { refresh?: boolean }) =>
    options.market.getCatalog({ refresh: payload?.refresh === true }),
  );
  ipcMain.handle(
    PlatformChannels.PetMarketInstall,
    (_event, payload: { petId: string; force?: boolean }) => {
      if (typeof payload?.petId !== "string") {
        return { ok: false, error: "invalid request" };
      }
      return options.market.install(payload.petId, payload.force === true);
    },
  );
  ipcMain.handle(PlatformChannels.PetMarketUninstall, (_event, payload: { petId: string }) => {
    if (typeof payload?.petId !== "string") {
      return { ok: false, error: "invalid request" };
    }
    return options.market.uninstall(payload.petId);
  });
  ipcMain.handle(PlatformChannels.PetMarketPreview, (_event, payload: { petId: string }) => {
    if (typeof payload?.petId !== "string") {
      return { error: "invalid request" };
    }
    return options.market.getPreviewDataUrl(payload.petId);
  });
  ipcMain.handle(PlatformChannels.PetImportFromCodex, () => options.market.importFromCodex());
}
