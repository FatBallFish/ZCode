import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServiceDescriptor } from "../src/platform/serviceManager.js";
import { serviceDescriptorBelongsToRoot } from "../src/runtime/serviceInstallation.js";

describe("service installation compatibility", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "only matches a legacy %s descriptor owned by the same server root",
    (platform) => {
      const firstRoot = "/var/lib/zcode-first/.mikiko/server";
      const secondRoot = "/var/lib/zcode-second/.mikiko/server";
      const descriptor = createServiceDescriptor({
        platform,
        command: join(firstRoot, "bin", platform === "win32" ? "mikiko.cmd" : "mikiko"),
        args: ["serve", "--supervisor", "--server-root", firstRoot],
      });

      expect(serviceDescriptorBelongsToRoot(descriptor.content, platform, firstRoot)).toBe(true);
      expect(serviceDescriptorBelongsToRoot(descriptor.content, platform, secondRoot)).toBe(false);
    },
  );
});
