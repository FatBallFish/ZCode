import type { BrowserControlPort } from "@zcode/contracts";
import { createExternalCdpBrowserRuntime, type ExternalCdpRuntimeOptions } from "./external.js";
import { parseExternalCdpOptions, type ExternalCdpOptions } from "./external-endpoint.js";
import type { ManagedCdpBrowserRuntime } from "./index.js";

export interface ExternalCdpInstance extends ExternalCdpOptions {
  id: string;
}
export interface ExternalCdpConfiguration {
  instances: ExternalCdpInstance[];
}
const INSTANCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function externalCdpDescriptorId(id: string): string {
  if (!INSTANCE_ID.test(id))
    throw new Error(
      "External instance ID must be a lowercase ASCII slug of at most 64 characters.",
    );
  return `cdp:external:${id}`;
}

export function parseExternalCdpConfiguration(value: string): ExternalCdpConfiguration {
  const raw: unknown = JSON.parse(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid external instance configuration.");
  const input = raw as Record<string, unknown>;
  if (!("instances" in input)) {
    return { instances: [{ ...parseExternalCdpOptions(value), id: "default" }] };
  }
  if (Object.keys(input).length !== 1 || !Array.isArray(input.instances))
    throw new Error("Configuration must contain only an instances array.");
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const instances = input.instances.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid external instance.");
    const entry = item as Record<string, unknown>;
    const { id, ...connection } = entry;
    if (typeof id !== "string") throw new Error("External instance requires an ID.");
    externalCdpDescriptorId(id);
    const options = parseExternalCdpOptions(JSON.stringify(connection));
    const endpoint = new URL(options.endpoint).origin;
    if (ids.has(id) || endpoints.has(endpoint))
      throw new Error("External instance IDs and endpoints must be unique.");
    ids.add(id);
    endpoints.add(endpoint);
    return { ...options, id, name: options.name ?? id };
  });
  return { instances };
}

export function createExternalCdpRegistry(
  configuration: ExternalCdpConfiguration,
  options: Pick<ExternalCdpRuntimeOptions, "loadPlaywright"> = {},
): ManagedCdpBrowserRuntime {
  // 同一解析路径用于 CLI/Desktop/API；先验证完整配置，不能部分创建后才发现重复实例。
  const validated = parseExternalCdpConfiguration(JSON.stringify(configuration));
  const runtimes = new Map(
    validated.instances.map((instance) => [
      externalCdpDescriptorId(instance.id),
      createExternalCdpBrowserRuntime({ ...instance, ...options, instanceId: instance.id }),
    ]),
  );
  let closed = false;
  const broadcast = async (operation: (port: BrowserControlPort) => Promise<void>) => {
    const settled = await Promise.allSettled(
      [...runtimes.values()].map((runtime) => operation(runtime.browserControlPort)),
    );
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
      throw new Error("External instance lifecycle failed.", { cause: failed.reason });
  };
  const browserControlPort: BrowserControlPort = {
    async list(input) {
      if (closed) return [];
      const settled = await Promise.allSettled(
        [...runtimes.values()].map((runtime) => runtime.browserControlPort.list(input)),
      );
      if (input.signal?.aborted) throw new Error("External discovery cancelled.");
      if (closed) return [];
      return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    },
    async execute(input) {
      const runtime = runtimes.get(input.browserId);
      if (closed || !runtime)
        return {
          ok: false,
          elapsedMs: 0,
          error: {
            code: "backend_unavailable",
            message: "External instance is unavailable; select an exact discovered browser ID.",
          },
        };
      return await runtime.browserControlPort.execute(input);
    },
    async turnEnded(input) {
      await broadcast(async (port) => {
        await port.turnEnded?.(input);
      });
    },
    async closeSession(input) {
      await broadcast(async (port) => {
        await port.closeSession?.(input);
      });
    },
  };
  return {
    browserControlPort,
    async close() {
      if (closed) return;
      closed = true;
      const settled = await Promise.allSettled(
        [...runtimes.values()].map((runtime) => runtime.close()),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected")
        throw new Error("External instance detach failed.", { cause: failed.reason });
    },
  };
}
