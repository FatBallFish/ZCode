import { useEffect } from "react";
import { subscribeToThemeSkinStorage } from "@/lib/themeSkinDom.js";

/**
 * 应用壁纸层（specs/ui/theme-skins.md §4）：垫在每个窗口内容之下，
 * 完全由 --app-wallpaper-* CSS 变量驱动（皮肤应用管线写入）。
 * - 图片层 blur 时向外扩 1.5 倍模糊半径，父级 overflow-hidden 裁掉边缘泛白；
 * - 纱层颜色按当前模式由应用管线计算（浅色白纱 / 深色黑纱，alpha=压暗度）；
 * - 会话独立窗口等 hook 宿主没有 store 广播，这里订阅 storage 事件重放皮肤。
 */
export function AppWallpaperLayer() {
  useEffect(() => subscribeToThemeSkinStorage(), []);

  return (
    <div
      aria-hidden="true"
      data-app-wallpaper-layer=""
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <div
        className="absolute"
        style={{
          inset: "calc(-1.5 * var(--app-wallpaper-blur, 0px))",
          background: "var(--app-wallpaper-layer, none)",
          filter: "blur(var(--app-wallpaper-blur, 0px))",
        }}
      />
      <div
        className="absolute inset-0"
        style={{ background: "var(--app-wallpaper-veil, transparent)" }}
      />
    </div>
  );
}
