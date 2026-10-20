import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createDaemonServiceDescriptor,
  createServiceDescriptor,
  serviceDescriptorPath,
} from "../src/platform/serviceManager.js";
import { resolveServerLayout, stablePathId } from "../src/runtime/paths.js";

describe("user service descriptors", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "pins the %s daemon descriptor to the data-root stable launcher and explicit server root",
    (platform) => {
      const layout = resolveServerLayout("/var/lib/zcode-custom/.mikiko/server");
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      const launcher = join(layout.stableBinDir, platform === "win32" ? "mikiko.cmd" : "mikiko");
      if (platform === "win32") {
        const task = JSON.parse(descriptor.content) as { command: string; args: string[] };
        expect(task.command).toBe(launcher);
        expect(task.args).toContain(layout.serverRoot);
      } else {
        expect(descriptor.content).toContain(launcher);
      }
      expect(descriptor.content).toContain("--server-root");
      expect(descriptor.content).toContain("--service-entry");
      if (platform !== "win32") {
        expect(descriptor.content).toContain(layout.serverRoot);
      }
      expect(descriptor.content).not.toContain("server-cli.js");
      expect(descriptor.name).toBe(`ai.mikiko.server.${stablePathId(layout.serverRoot)}`);
    },
  );

  it("isolates service identity and descriptor filenames by server root", () => {
    const firstLayout = resolveServerLayout("/var/lib/zcode-first/.mikiko/server");
    const secondLayout = resolveServerLayout("/var/lib/zcode-second/.mikiko/server");
    const first = createDaemonServiceDescriptor({ platform: "linux", layout: firstLayout });
    const second = createDaemonServiceDescriptor({ platform: "linux", layout: secondLayout });

    expect(first.name).not.toBe(second.name);
    expect(serviceDescriptorPath(firstLayout, first)).toBe(
      join(firstLayout.serviceDir, `${first.name}.service`),
    );
    expect(serviceDescriptorPath(secondLayout, second)).toBe(
      join(secondLayout.serviceDir, `${second.name}.service`),
    );
  });
});
