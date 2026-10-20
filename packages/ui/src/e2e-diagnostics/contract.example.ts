import { shouldExposeE2EStoreBridge } from "./contract.js";
/** Expose the existing owner reference only when the one test capability gate allows it. */
export function existingE2EOwner<T>(owner: T): T | null {
  return shouldExposeE2EStoreBridge() ? owner : null;
}
