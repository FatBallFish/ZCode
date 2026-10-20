import type { IServiceAccessor, IPlatformService } from "./contract.js";
/** Keep the source attachment; renderer panes remain local to the destination window. */
export function sessionWindowDependencies(services: IServiceAccessor, platform: IPlatformService) {
  return { services, platform };
}
