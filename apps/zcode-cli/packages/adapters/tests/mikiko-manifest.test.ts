import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function discover(manifests: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "mikiko-manifest-"));
  roots.push(root);
  for (const [directory, name] of Object.entries(manifests)) {
    await mkdir(join(root, directory));
    await writeFile(
      join(root, directory, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
  }
  const storageRoot = join(root, "storage");
  return createNodePluginAdapter({ storageRoot }).discoverPlugins({
    config: { dirs: [root], enabled: true, enabledPlugins: {}, options: {} },
    env: {},
    storageRoot,
    workingDirectory: root,
  });
}

describe("Mikiko 插件 manifest 兼容发现", () => {
  it.each([".mikiko-plugin", ".zcode-plugin", ".claude-plugin"])(
    "%s 插件保持同一发现链路",
    async (directory) => {
      const result = await discover({ [directory]: "sample" });
      expect(result.plugins.map((plugin) => plugin.id)).toEqual(["sample@inline"]);
      expect(result.diagnostics).toEqual([]);
    },
  );

  it("Mikiko manifest 优先于历史 ZCode / Claude 副本", async () => {
    const result = await discover({
      ".mikiko-plugin": "current",
      ".zcode-plugin": "legacy",
      ".claude-plugin": "claude",
    });
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["current@inline"]);
  });
});
