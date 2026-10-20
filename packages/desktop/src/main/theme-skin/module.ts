export const desktopThemeSkinModule = {
  id: "desktop-theme-skin",
  requires: ["desktop", "shared"],
  provides: ["desktop-theme-skin"],
  publicEntrypoints: ["index.ts", "contract.ts", "../desktopThemeSkinService.ts"],
} as const;
