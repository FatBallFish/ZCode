/** Main owns native pet windows; renderer requests are commands against the same manager. */
export type { DesktopPetManager, DesktopPetManagerDeps } from "../desktopPetWindow.js";
export type { PetDragController, PetDragControllerDeps } from "../desktopPetDragController.js";
export { sha256Hex, loadInstalledPetFromDir } from "../petPackIo.js";
