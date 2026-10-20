import { mikikoUpdateHttpWorker, type MikikoUpdateBindings } from "./contract.js";
/** Request/HTTP bindings are injected; deployment and publishing remain explicit release operations. */
export function serveMikikoUpdateRequest(
  request: Request,
  bindings: MikikoUpdateBindings,
): Promise<Response> {
  return mikikoUpdateHttpWorker.fetch(request, bindings);
}
