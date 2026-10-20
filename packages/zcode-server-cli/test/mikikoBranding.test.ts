import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createDaemonServiceDescriptor } from "../src/platform/serviceManager.js";
import { resolveServerLayout, serverDataRootFromBase } from "../src/runtime/paths.js";

describe("Mikiko Source Server 产品边界", () => {
  it("显式数据根派生到 Mikiko 目录，不写官方目录", () => {
    expect(serverDataRootFromBase("/tmp/mikiko-source-brand")).toBe(
      join("/tmp/mikiko-source-brand", ".mikiko", "server"),
    );
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "%s 后台服务使用 Mikiko 名称与启动器",
    (platform) => {
      const layout = resolveServerLayout("/tmp/mikiko-source-brand/.mikiko/server");
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      expect(descriptor.name).toMatch(/^ai\.mikiko\.server\./u);
      expect(descriptor.content).toContain(platform === "win32" ? "mikiko.cmd" : "mikiko");
      expect(descriptor.content).not.toMatch(/zhipu|zcode/iu);
    },
  );
});
