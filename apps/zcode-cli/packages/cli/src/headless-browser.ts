import {
  createExternalCdpRegistry,
  parseExternalCdpConfiguration,
  createManagedCdpBrowserRuntime,
  type ManagedCdpBrowserRuntime,
} from "@zcode/adapters/browser";
import type { GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";
import { loadCliPlaywrightChromium } from "./sea-playwright-runtime.js";

export function createCliHeadlessBrowserRuntime(
  options: Pick<
    GlobalOptions,
    | "browserExecutable"
    | "browserUse"
    | "browserEndpoint"
    | "browserName"
    | "browserIdentity"
    | "browserInstances"
  >,
  deps: RunDependencies,
): ManagedCdpBrowserRuntime | undefined {
  if (options.browserUse === "external") {
    const configuration =
      options.browserInstances ??
      JSON.stringify({
        endpoint: options.browserEndpoint,
        name: options.browserName,
        expectedBrowserId: options.browserIdentity,
      });
    if (
      options.browserInstances &&
      (options.browserEndpoint || options.browserName || options.browserIdentity)
    ) {
      throw new Error("--browser-instances cannot be combined with single-instance flags.");
    }
    return createExternalCdpRegistry(parseExternalCdpConfiguration(configuration), {
      loadPlaywright: loadCliPlaywrightChromium,
    });
  }
  if (options.browserUse !== "headless") return undefined;
  const factory = deps.createManagedCdpBrowserRuntime ?? createManagedCdpBrowserRuntime;
  return factory({
    env: deps.env,
    executablePath: options.browserExecutable,
    loadPlaywright: loadCliPlaywrightChromium,
  });
}
