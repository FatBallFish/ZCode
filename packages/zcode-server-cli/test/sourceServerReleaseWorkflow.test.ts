import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function recovery(
  options: { legacy?: boolean; missing?: boolean; wrongCommit?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mikiko-source-recovery-"));
  roots.push(root);
  const bin = join(root, "bin");
  const artifact = join(root, "artifact");
  const destination = join(root, "restored");
  const output = join(root, "github-output");
  const calls = join(root, "gh-calls");
  await mkdir(bin);
  await mkdir(artifact);
  const build = {
    schemaVersion: 1,
    sourceRunId: "100",
    commit: options.wrongCommit ? "b".repeat(40) : "a".repeat(40),
    tag: "v1.2.3",
    version: "1.2.3",
  };
  await writeFile(join(artifact, "source-server-build.json"), JSON.stringify(build));
  const sourceWorkflow = options.legacy
    ? "jobs:\n  build:\n    runs-on: ubuntu-latest\n"
    : "jobs:\n  source-server:\n    runs-on: ubuntu-latest\n";
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='api'&&args[1].includes('/contents/')) {
 console.log(JSON.stringify({encoding:'base64',content:${JSON.stringify(Buffer.from(sourceWorkflow).toString("base64"))}}));
} else if(args[0]==='api') {
 console.log(JSON.stringify({head_branch:'v1.2.3',head_sha:'${"a".repeat(40)}',path:'.github/workflows/release-desktop.yml'}));
} else if(args[0]==='run'&&args[1]==='download') {
 if(${JSON.stringify(Boolean(options.missing))})process.exit(1);
 fs.cpSync(${JSON.stringify(artifact)},args[args.indexOf('--dir')+1],{recursive:true});
} else process.exit(2);
`,
  );
  await chmod(gh, 0o755);
  const run = () =>
    exec(
      process.execPath,
      [
        resolve(repositoryRoot, ".github/scripts/release-artifacts.mjs"),
        "download-source-server",
        "100",
        "unused",
        destination,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          GH_TOKEN: "fixture-token",
          GITHUB_REPOSITORY: "local/test",
          RELEASE_TAG: "v1.2.3",
          GITHUB_OUTPUT: output,
        },
      },
    );
  return { destination, output, calls, run };
}

describe("Source Server 发行恢复合同", () => {
  it("四target唯一构建入口保存原run身份，先发布远端资源再开放桌面发行", async () => {
    const workflow = parse(
      await readFile(resolve(repositoryRoot, ".github/workflows/release-desktop.yml"), "utf8"),
    );
    const build = workflow.jobs["source-server"];
    expect(build.if).toContain("!inputs.source-run-id");
    expect(
      build.steps.find(
        (step: { name: string }) => step.name === "Stage all four Source Server targets",
      ).run,
    ).toBe("pnpm prepare:remote-assets");
    const artifact = build.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(artifact.with.name).toBe("source-server-release");
    expect(workflow.jobs.release.needs).toContain("publish-source-server");
    expect(workflow.jobs["publish-source-server"].needs).toContain("notarize");
    expect(workflow.jobs["publish-source-server"].if).toContain("!inputs.publish-feed-only");
    const publish = workflow.jobs["publish-source-server"].steps.find(
      (step: { name: string }) =>
        step.name === "Publish verified Source Server objects and indexes",
    );
    expect(publish.if).toContain("available == 'true'");
    expect(publish.run).toContain('--source-run-id "$SOURCE_RUN_ID" --commit "$SOURCE_COMMIT"');
  });

  it.skipIf(process.platform === "win32")(
    "只恢复原run的Source Server artifact并核对commit/tag/version",
    async () => {
      const fixture = await recovery();
      await fixture.run();
      expect(await readFile(fixture.output, "utf8")).toContain("available=true");
      const calls = (await readFile(fixture.calls, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      expect(calls.find((args: string[]) => args[0] === "run").slice(0, 3)).toEqual([
        "run",
        "download",
        "100",
      ]);
      expect(
        await readFile(join(fixture.destination, "source-server-build.json"), "utf8"),
      ).toContain('"sourceRunId":"100"');
    },
  );

  it.skipIf(process.platform === "win32")(
    "旧workflow没有新增artifact时明确legacy跳过，绝不重编译HEAD",
    async () => {
      const fixture = await recovery({ legacy: true, missing: true });
      const result = await fixture.run();
      expect(result.stdout).toContain("without rebuilding HEAD");
      expect(await readFile(fixture.output, "utf8")).toContain("available=false");
      await expect(access(fixture.destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(fixture.calls, "utf8")).not.toContain('"download"');
    },
  );

  it.skipIf(process.platform === "win32")(
    "原workflow声明过构建却缺artifact时失败，不借其他run或重建",
    async () => {
      const fixture = await recovery({ missing: true });
      await expect(fixture.run()).rejects.toThrow(/original run 100; no rebuild performed/u);
    },
  );

  it.skipIf(process.platform === "win32")("恢复产物commit不一致时拒绝", async () => {
    const fixture = await recovery({ wrongCommit: true });
    await expect(fixture.run()).rejects.toThrow(/original build identity mismatch/u);
  });
});
