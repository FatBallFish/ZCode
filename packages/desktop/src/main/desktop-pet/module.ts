export const desktopPetModule = {
  id: "desktop-pet",
  requires: ["desktop", "shared"],
  provides: ["desktop-pet"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "../desktopPetWindow.ts",
    "../desktopPetDragController.ts",
    "../petPackIo.ts",
  ],
} as const;
