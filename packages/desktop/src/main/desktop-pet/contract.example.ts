import type { DesktopPetManager } from "./contract.js";
/** Installation, drag and window ownership remain in the injected native manager. */
export function nativePetManager(owner: DesktopPetManager): DesktopPetManager {
  return owner;
}
