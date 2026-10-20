import type { ISub2ApiService } from "./contract.js";
/** The existing service descriptor is injected; UI does not build a parallel credential repository. */
export function loginServicePort(service: ISub2ApiService): ISub2ApiService {
  return service;
}
