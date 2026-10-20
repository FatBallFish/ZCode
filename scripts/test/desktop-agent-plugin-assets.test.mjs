import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  officialPluginPackages,
  stageOfficialPlugins,
  stageBundledSkillPack,
} from "../../packages/desktop/scripts/prepare-agent-node-bundle.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mikiko-plugin-staging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo");
  const glmDir = join(root, "staged");
  for (const plugin of officialPluginPackages) {
    const source = join(repoRoot, plugin.relativePath);
    const manifest = join(source, ".mikiko-plugin", "plugin.json");
    await mkdir(dirname(manifest), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: plugin.packageName, version: "1.0.0" }));
    for (const relative of new Set([
      ...(plugin.requiredSeedPaths ?? []),
      ...(plugin.requiredRuntimePaths ?? []),
    ])) {
      const path = join(source, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, relative);
    }
  }
  return { root, repoRoot, glmDir, log() {} };
}

test("stages Mikiko manifests, Office runtimes and browser/node host assets beside the CLI", async (t) => {
  const options = await fixture(t);
  await stageOfficialPlugins(options);
  for (const name of ["documents", "pdf", "presentations", "spreadsheets"]) {
    const root = join(options.glmDir, "packages", `${name}-plugin`);
    await access(join(root, ".mikiko-plugin", "plugin.json"));
    assert.equal(await readFile(join(root, "dist", "server.mjs"), "utf8"), "dist/server.mjs");
    await access(join(root, "dist", "ui", "panel.html"));
  }
  await access(join(options.glmDir, "packages", "node-repl-host", "dist", "mcp", "server.js"));
  await access(
    join(options.glmDir, "packages", "browser-use-plugin", "scripts", "browser-client.mjs"),
  );
});

test("accepts a legacy manifest while keeping Mikiko priority and excluding dependency caches", async (t) => {
  const options = await fixture(t);
  const plugin = officialPluginPackages[0];
  const root = join(options.repoRoot, plugin.relativePath);
  await mkdir(join(root, ".zcode-plugin"), { recursive: true });
  await writeFile(join(root, ".zcode-plugin", "plugin.json"), '{"name":"legacy"}');
  await mkdir(join(root, "dist", "node_modules"), { recursive: true });
  await writeFile(join(root, "dist", "node_modules", "secret.txt"), "must not be staged");
  await stageOfficialPlugins(options);
  const staged = join(options.glmDir, plugin.stagedPath);
  assert.equal(
    JSON.parse(await readFile(join(staged, ".mikiko-plugin", "plugin.json"))).name,
    plugin.packageName,
  );
  await assert.rejects(access(join(staged, "dist", "node_modules", "secret.txt")));
  await rm(join(root, ".mikiko-plugin"), { recursive: true });
  await stageOfficialPlugins(options);
  await access(join(staged, ".zcode-plugin", "plugin.json"));
});

test("fails before claiming a successful stage when a required runtime is absent", async (t) => {
  const options = await fixture(t);
  const pdf = officialPluginPackages.find((plugin) => plugin.packageName === "@zcode/pdf-plugin");
  await rm(join(options.repoRoot, pdf.relativePath, "dist", "server.mjs"));
  await assert.rejects(
    async () => stageOfficialPlugins(options),
    /missing.*(?:runtime|seed asset)/i,
  );
});

test("the same stage entry includes the dynamic workflow skill pack", async (t) => {
  const options = await fixture(t);
  const source = join(options.repoRoot, "apps/zcode-cli/packages/bundled-skills");
  for (const name of ["SKILL.md", "patterns.md", "examples.md"]) {
    const path = join(source, "skills/dynamic-workflows", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name);
  }
  await stageBundledSkillPack(options);
  await access(join(options.glmDir, "packages/bundled-skills/skills/dynamic-workflows/SKILL.md"));
});
