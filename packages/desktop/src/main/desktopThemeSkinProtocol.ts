import type { protocol } from "electron";
import { THEME_SKIN_SCHEME } from "@zcode/shared";

/**
 * 主题皮肤壁纸协议（specs/ui/theme-skins.md §4）：themepack://local/asset?path=<abs>
 * 只放行 theme-skins 根目录（含 .staging 暂存）内的 png/jpg/jpeg/webp。
 * 参照 desktopPetWindow 的 registerFileProtocol 先例（Electron 41 下比 protocol.handle 稳）。
 */

export const THEME_SKIN_PRIVILEGED_SCHEME = {
  scheme: THEME_SKIN_SCHEME,
  privileges: { standard: true, secure: true, stream: true },
} as const;

const NET_ERR_INVALID_URL = -300;

export function installThemeSkinProtocol(
  electronProtocol: typeof protocol,
  options: { isPathAllowed: (path: string) => boolean },
): void {
  electronProtocol.registerFileProtocol(THEME_SKIN_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const path = url.searchParams.get("path") ?? "";
      if (url.hostname !== "local" || url.pathname !== "/asset" || !options.isPathAllowed(path)) {
        callback({ error: NET_ERR_INVALID_URL });
        return;
      }
      callback({ path });
    } catch {
      callback({ error: NET_ERR_INVALID_URL });
    }
  });
}
