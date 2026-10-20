import type { RemoteControlPendingAction } from "./contract.js";
/** Pending is UI intent only; connected/paired facts must come from Main events. */
export function remoteActionPending(action: RemoteControlPendingAction | null): boolean {
  return action !== null;
}
