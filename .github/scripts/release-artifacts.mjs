#!/usr/bin/env node
/** 恢复只能读取同一 tag 的原始构建与该 sourceRunId 的状态；不要通过重跑编译恢复公证。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const exec = promisify(execFile);
const repository = process.env.GITHUB_REPOSITORY;
async function gh(args) {
  return (await exec("gh", args, { maxBuffer: 32 * 1024 * 1024 })).stdout;
}
const [mode, sourceRunId, arch, targetDir] = process.argv.slice(2);
if (!/^\d+$/.test(sourceRunId ?? "") || !repository)
  throw new Error("Missing release source run identity");
const run = JSON.parse(await gh(["api", `repos/${repository}/actions/runs/${sourceRunId}`]));
if (
  run.head_branch !== process.env.RELEASE_TAG ||
  !/^v\d+\.\d+\.\d+$/.test(process.env.RELEASE_TAG ?? "")
)
  throw new Error("Original run/tag identity mismatch");
if (!run.path?.startsWith(".github/workflows/release-desktop.yml"))
  throw new Error("Source must be a desktop release build");
if (mode === "validate") {
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `commit=${run.head_sha}\n`, { flag: "a" });
  console.log(
    `Release source validated: run=${sourceRunId} tag=${run.head_branch} commit=${run.head_sha}`,
  );
} else if (mode === "restore-state") {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Invalid state architecture");
  const pages = JSON.parse(
    await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/artifacts?per_page=100`,
    ]),
  );
  const prefix = `notary-state-${sourceRunId}-${arch}-`;
  const candidates = pages
    .flatMap((page) => page.artifacts)
    .filter((artifact) => !artifact.expired && artifact.name.startsWith(prefix))
    .sort((left, right) => right.id - left.id);
  await mkdir(resolve(targetDir), { recursive: true });
  if (candidates.length) {
    const artifact = candidates[0];
    await gh([
      "run",
      "download",
      String(artifact.workflow_run.id),
      "--repo",
      repository,
      "--name",
      artifact.name,
      "--dir",
      resolve(targetDir),
    ]);
    console.log(
      `Restored notarization state from run ${artifact.workflow_run.id}: ${artifact.name}`,
    );
  } else console.log("No previous state artifact; Apple history will be checked before any submit");
} else if (mode === "download-release") {
  const destination = resolve(targetDir);
  const macRunId = process.env.MAC_RUN_ID;
  if (!/^\d+$/.test(macRunId ?? "")) throw new Error("Missing verified Mac run ID");
  await mkdir(destination, { recursive: true });
  for (const name of [
    "installers-win-x64",
    "installers-win-arm64",
    "installers-linux-x64",
    "relay-server-deploy",
    "relay-cloudflare-deploy",
  ]) {
    await gh([
      "run",
      "download",
      sourceRunId,
      "--repo",
      repository,
      "--name",
      name,
      "--dir",
      join(destination, name),
    ]);
  }
  for (const name of ["installers-mac-arm64", "installers-mac-x64"]) {
    await gh([
      "run",
      "download",
      macRunId,
      "--repo",
      repository,
      "--name",
      name,
      "--dir",
      join(destination, name),
    ]);
  }
} else throw new Error(`Unknown release artifact operation: ${mode}`);
