import type { ThemeSkinService } from "./contract.js";
/** Read existing installed records without changing the selected renderer skin. */
export function installedSkinChoices(service: ThemeSkinService) {
  return service.listInstalled();
}
