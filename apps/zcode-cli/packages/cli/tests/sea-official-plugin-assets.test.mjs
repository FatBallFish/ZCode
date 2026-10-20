import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
} from "../scripts/sea-official-plugin-assets.mjs";

test("includes the document judge agent in official SEA assets", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { manifest } = await collectSeaOfficialPluginAssets({
      root,
      stagingDirectory,
    });
    assert.equal(
      manifest.plugins.some((plugin) => plugin.name === "document-skills"),
      false,
    );
    for (const [name, skill] of [
      ["documents", "docx"],
      ["pdf", "pdf"],
      ["presentations", "pptx"],
      ["spreadsheets", "xlsx"],
    ]) {
      const plugin = manifest.plugins.find((plugin) => plugin.name === name);
      assert.ok(plugin, `missing ${name} SEA manifest entry`);
      // SEA 索引必须与当前插件包的真实版本一致，各 Office 插件可独立修订。
      const packageManifest = JSON.parse(
        await readFile(join(root, "packages", `${name}-plugin`, "package.json"), "utf8"),
      );
      assert.equal(plugin.version, packageManifest.version);
      for (const path of [
        ".mikiko-plugin/plugin.json",
        "agents/visual-judge.md",
        `skills/${skill}/SKILL.md`,
      ])
        assert.ok(
          plugin.files.some((file) => file.path === path),
          `${name}: ${path}`,
        );
    }
    const creator = manifest.plugins.find((plugin) => plugin.name === "plugin-creator");
    assert.ok(creator, "missing plugin-creator SEA manifest entry");
    for (const path of [
      ".zcode-plugin/plugin.json",
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ])
      assert.ok(
        creator.files.some((file) => file.path === path),
        `missing ${path}`,
      );
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
});

test("rejects an incomplete documents SEA seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-missing-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    // 先准备排在 documents 前面的合法 seed，故障必须命中待验证的文档必需资产。
    for (const plugin of officialSeaPlugins) {
      await writeTestFile(root, join(plugin.rootPath, ".mikiko-plugin/plugin.json"), "{}");
      if (plugin.name === "documents") break;
      for (const path of plugin.requiredSeedPaths ?? [])
        await writeTestFile(root, join(plugin.rootPath, path), "fixture");
    }

    await assert.rejects(
      collectSeaOfficialPluginAssets({ root, stagingDirectory }),
      /Missing documents required seed asset.*agents[/\\]visual-judge\.md/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function writeTestFile(root, relativePath, content) {
  const filePath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
