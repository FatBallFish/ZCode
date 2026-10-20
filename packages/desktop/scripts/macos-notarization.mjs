#!/usr/bin/env node
/** 可恢复公证：原包 manifest 与 state 是唯一身份及提交所有者；见 specs/desktop/macos-signing.md。 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { addSubmissionCandidate, waitCandidateNotarizations } from "./notary-submissions.mjs";

const execFileAsync = promisify(execFile);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
function safePath(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\\") ||
    relative.split("/").includes("..")
  )
    throw new Error("Unsafe artifact path");
  const path = resolve(root, relative);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error("Unsafe artifact path");
  return path;
}
export async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), size: (await stat(path)).size };
}
export async function createBundleManifest(dir, identity) {
  if (
    !/^\d+$/.test(identity.sourceRunId) ||
    !["arm64", "x64"].includes(identity.arch) ||
    !/^[a-f0-9]{40}$/.test(identity.commit)
  )
    throw new Error("Invalid bundle identity");
  const names = (await readdir(dir))
    .filter((name) => /\.(dmg|zip|blockmap|yml)$/.test(name))
    .sort();
  const dmgs = names.filter((name) => name.endsWith(".dmg"));
  const zips = names.filter((name) => name.endsWith(".zip"));
  if (dmgs.length !== 1 || zips.length !== 1) throw new Error("Expected exactly one DMG and ZIP");
  const appDirectory = identity.arch === "arm64" ? "mac-arm64" : "mac";
  const apps = (await readdir(join(dir, appDirectory))).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("Expected one App bundle");
  const manifest = {
    schema: 1,
    ...identity,
    dmg: dmgs[0],
    zip: zips[0],
    app: `${appDirectory}/${apps[0]}`,
    files: {},
  };
  for (const name of names) manifest.files[name] = await fileDigest(join(dir, name));
  await saveJson(join(dir, "signed-bundle.json"), manifest);
  return manifest;
}
export async function verifyBundleManifest(dir, bundle, expected) {
  if (
    bundle.schema !== 1 ||
    !["arm64", "x64"].includes(bundle.arch) ||
    !/^\d+$/.test(bundle.sourceRunId) ||
    !/^[a-f0-9]{40}$/.test(bundle.commit)
  )
    throw new Error("Invalid bundle identity");
  for (const key of ["sourceRunId", "ref", "arch"])
    if (bundle[key] !== expected[key]) throw new Error(`Bundle identity mismatch: ${key}`);
  if (expected.commit && bundle.commit !== expected.commit)
    throw new Error("Bundle commit identity mismatch");
  if (bundle.ref !== `v${bundle.version}`) throw new Error("Bundle version identity mismatch");
  safePath(dir, bundle.app);
  if (!bundle.files[bundle.dmg] || !bundle.files[bundle.zip])
    throw new Error("Missing archived artifact hash");
  for (const [name, recorded] of Object.entries(bundle.files)) {
    const actual = await fileDigest(safePath(dir, name));
    if (actual.sha256 !== recorded.sha256 || actual.size !== recorded.size)
      throw new Error(`Artifact hash mismatch: ${name}`);
  }
}
function stateIdentity(bundle) {
  return {
    sourceRunId: bundle.sourceRunId,
    commit: bundle.commit,
    ref: bundle.ref,
    version: bundle.version,
    arch: bundle.arch,
    archiveSha256: bundle.files[bundle.dmg].sha256,
  };
}
function checkState(bundle, state) {
  for (const [key, value] of Object.entries(stateIdentity(bundle)))
    if (state[key] !== value) throw new Error(`Notarization state identity mismatch: ${key}`);
}
export async function prepareSubmissionIntent({ bundle, statePath }) {
  const existing = await readOptionalJson(statePath);
  if (existing) {
    checkState(bundle, existing);
    return false;
  }
  await saveJson(statePath, {
    ...stateIdentity(bundle),
    phase: "intent",
    startedAt: new Date().toISOString(),
  });
  return true;
}
export async function submitNotarization({
  dir,
  bundle,
  statePath,
  runNotary,
  allowNewSubmission = false,
}) {
  let state = await readOptionalJson(statePath);
  if (state) {
    checkState(bundle, state);
    if (state.id) {
      console.log(`Reuse notarization submission ${state.id}`);
      return state;
    }
  }
  const uploadName = `${basename(bundle.dmg, ".dmg")}-${bundle.files[bundle.dmg].sha256}.dmg`;
  // submit 的网络响应丢失时，使用完整内容哈希命名找回 Apple 已接收的提交，不盲目重交。
  const history = await runNotary(["history"]);
  if (!Array.isArray(history.history)) throw new Error("Invalid notarization history response");
  const matches = history.history.filter((item) => item.name === uploadName);
  if (matches.length > 1)
    throw new Error("Multiple matching submissions; inspect Apple history before continuing");
  if (matches.length === 1) {
    if (!matches[0].id) throw new Error("Invalid submission history identity");
    state = {
      ...stateIdentity(bundle),
      uploadName,
      id: matches[0].id,
      status: matches[0].status,
      phase: "submitted",
    };
    await saveJson(statePath, state);
    return state;
  }
  if (state?.phase === "submitting" || (state?.phase === "intent" && !allowNewSubmission))
    throw new Error(
      "Submission uncertain: no matching Apple history entry; inspect history before retrying, do not rebuild",
    );
  state = {
    ...stateIdentity(bundle),
    uploadName,
    phase: "submitting",
    startedAt: new Date().toISOString(),
  };
  await saveJson(statePath, state);
  const uploadPath = join(dirname(statePath), uploadName);
  await copyFile(safePath(dir, bundle.dmg), uploadPath);
  try {
    const result = await runNotary(["submit", uploadPath, "--no-wait"]);
    if (!result.id) throw new Error("Submission uncertain: Apple did not return submission ID");
    state = { ...state, id: result.id, phase: "submitted", status: "In Progress" };
    await saveJson(statePath, state);
    console.log(`Saved notarization submission ${state.id}`);
    return state;
  } finally {
    // 状态 artifact 只保留身份/日志，不重复上传几百 MB 的原包。
    const { rm } = await import("node:fs/promises");
    await rm(uploadPath, { force: true });
  }
}
export async function adoptNotarizationSubmission({ bundle, statePath, submissionId, runNotary }) {
  const state = await readJson(statePath);
  checkState(bundle, state);
  await addSubmissionCandidate({ bundle, state, submissionId, runNotary });
  await saveJson(statePath, state);
  console.log(`Tracking same-package notarization submission ${submissionId}`);
  return state;
}
export async function waitNotarization({
  bundle,
  statePath,
  runNotary,
  timeout = "20m",
  now = Date.now,
  sleep = delay,
}) {
  const state = await readJson(statePath);
  checkState(bundle, state);
  if (!state.id) throw new Error("No submission ID; recover submission before waiting");
  if (state.submissions)
    return waitCandidateNotarizations({
      bundle,
      state,
      statePath,
      saveJson,
      runNotary,
      timeout,
      now,
      sleep,
    });
  let result = await runNotary(["info", state.id]);
  if (result.status === "In Progress") {
    try {
      await runNotary(["wait", state.id, "--timeout", timeout]);
    } catch {
      console.log("Bounded wait ended; query the same submission again");
    }
    result = await runNotary(["info", state.id]);
  }
  state.status = result.status;
  state.checkedAt = new Date().toISOString();
  state.phase = result.status === "Accepted" ? "accepted" : "submitted";
  await saveJson(statePath, state);
  if (result.status === "Accepted") return true;
  if (result.status === "In Progress") return false;
  try {
    await saveJson(join(dirname(statePath), "notary-log.json"), await runNotary(["log", state.id]));
  } catch {
    console.error("Could not retrieve rejection log; use notarytool log with saved submission ID");
  }
  throw new Error(
    `Apple notarization status: ${result.status ?? "unknown"}; existing submission retained`,
  );
}
export function notaryCredentials(env = process.env) {
  if (env.APPLE_KEYCHAIN_PROFILE) return ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_API_KEY_PATH && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    return [
      "--key",
      env.APPLE_API_KEY_PATH,
      "--key-id",
      env.APPLE_API_KEY_ID,
      "--issuer",
      env.APPLE_API_ISSUER,
    ];
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
    return [
      "--apple-id",
      env.APPLE_ID,
      "--password",
      env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      env.APPLE_TEAM_ID,
    ];
  throw new Error("Missing Apple notarization credentials");
}
export async function runNotary(args, options = {}) {
  const command = ["notarytool", ...args, ...notaryCredentials(), "--output-format", "json"];
  try {
    const { stdout } = await execFileAsync("xcrun", command, {
      timeout: options.timeout ?? 25 * 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    // execFile.message 含带密码的完整参数，不能落盘或上传日志。
    throw new Error(
      `notarytool ${args[0]} failed (exit ${error.code ?? "unknown"}); credentials and submission data retained`,
    );
  }
}
async function main() {
  const [phase, inputDir, inputStateDir] = process.argv.slice(2);
  const dir = resolve(inputDir);
  const stateDir = resolve(inputStateDir ?? "notary-state");
  const statePath = join(stateDir, "state.json");
  if (phase === "prepare") {
    const version = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ).version;
    await createBundleManifest(dir, {
      sourceRunId: process.env.GITHUB_RUN_ID,
      commit: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF_NAME,
      arch: process.env.NOTARY_ARCH,
      version,
    });
    return;
  }
  const bundle = await readJson(join(dir, "signed-bundle.json"));
  await verifyBundleManifest(dir, bundle, {
    sourceRunId: process.env.SOURCE_RUN_ID,
    ref: process.env.RELEASE_TAG,
    arch: process.env.NOTARY_ARCH,
    commit: process.env.SOURCE_COMMIT,
  });
  if (phase === "intent") {
    const fresh = await prepareSubmissionIntent({ bundle, statePath });
    if (process.env.GITHUB_OUTPUT)
      await writeFile(process.env.GITHUB_OUTPUT, `fresh=${fresh}\n`, { flag: "a" });
  } else if (phase === "submit")
    await submitNotarization({
      dir,
      bundle,
      statePath,
      runNotary,
      allowNewSubmission: process.env.ALLOW_NEW_SUBMISSION === "true",
    });
  else if (phase === "adopt") {
    await adoptNotarizationSubmission({
      bundle,
      statePath,
      submissionId: process.env.ADDITIONAL_NOTARY_ID,
      runNotary,
    });
  } else if (phase === "wait") {
    const ready = await waitNotarization({
      bundle,
      statePath,
      runNotary,
      timeout: process.env.NOTARY_WAIT_TIMEOUT ?? "20m",
    });
    if (process.env.GITHUB_OUTPUT)
      await writeFile(process.env.GITHUB_OUTPUT, `ready=${ready}\n`, { flag: "a" });
    if (!ready)
      console.log(
        `Apple still processing. Resume source-run-id=${bundle.sourceRunId}; do not rebuild or submit again.`,
      );
  } else if (phase === "finalize") {
    const state = await readJson(statePath);
    checkState(bundle, state);
    if (state.status !== "Accepted")
      throw new Error("Cannot finalize a submission without Accepted status");
    const { finalizeMacArtifacts } = await import("./finalize-macos-artifacts.mjs");
    await finalizeMacArtifacts(dir, bundle, state);
  } else throw new Error(`Unknown notarization phase: ${phase}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
