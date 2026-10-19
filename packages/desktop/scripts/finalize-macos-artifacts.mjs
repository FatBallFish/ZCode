#!/usr/bin/env node
/** Accepted 后只附加 ticket 与重新封装 ZIP；不重新 codesign，不更改原 DMG 内的 App。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileDigest } from "./macos-notarization.mjs";

const execFileAsync = promisify(execFile);
async function run(command, args) {
  console.log(`[finalize] ${command} ${args.join(" ")}`);
  const result = await execFileAsync(command, args, {
    timeout: 5 * 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.log(result.stderr.trim());
  return result;
}
async function verifyApp(app) {
  await run("codesign", ["--verify", "--deep", "--strict", app]);
  await run("spctl", ["-a", "-vv", "-t", "exec", app]);
}
async function cdhash(app) {
  const { stderr } = await run("codesign", ["-d", "--verbose=4", app]);
  const hash = stderr.match(/^CDHash=(.+)$/m)?.[1];
  if (!hash) throw new Error("Cannot read App code identity");
  return hash;
}
export async function finalizeMacArtifacts(dir, bundle, state) {
  if (state.status !== "Accepted" || !state.id)
    throw new Error("Finalization requires Apple Accepted status");
  const dmg = join(dir, bundle.dmg);
  const zip = join(dir, bundle.zip);
  const app = join(dir, bundle.app);
  const appName = bundle.app.split("/").at(-1);
  await run("codesign", ["--verify", dmg]);
  await verifyApp(app);
  await run("xcrun", ["stapler", "staple", dmg]);
  await run("xcrun", ["stapler", "validate", dmg]);
  await run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dmg]);
  const mount = await mkdtemp(join(tmpdir(), "release-notarized-dmg-"));
  let mounted = false;
  try {
    await run("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
    mounted = true;
    const installed = join(mount, appName);
    await verifyApp(installed);
    // 必须确认 ZIP 的独立 App 与 Apple 公证的 DMG payload 是同一代码身份。
    if ((await cdhash(installed)) !== (await cdhash(app)))
      throw new Error("DMG/App code identity mismatch");
  } finally {
    if (mounted) await run("hdiutil", ["detach", mount]);
    await rm(mount, { recursive: true, force: true });
  }
  await run("xcrun", ["stapler", "staple", app]);
  await run("xcrun", ["stapler", "validate", app]);
  await verifyApp(app);
  const temporaryZip = `${zip}.final.zip`;
  await rm(temporaryZip, { force: true });
  await run("ditto", ["-c", "-k", "--keepParent", app, temporaryZip]);
  const extracted = await mkdtemp(join(tmpdir(), "release-notarized-zip-"));
  try {
    await run("ditto", ["-x", "-k", temporaryZip, extracted]);
    const installed = join(extracted, appName);
    await verifyApp(installed);
    await run("xcrun", ["stapler", "validate", installed]);
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
  await rename(temporaryZip, zip);
  const metadataScript = new URL("./refresh-macos-artifact-metadata.mjs", import.meta.url);
  const { fileURLToPath } = await import("node:url");
  await run(process.execPath, [fileURLToPath(metadataScript), dmg]);
  await run(process.execPath, [fileURLToPath(metadataScript), zip]);
  const verification = {
    schema: 1,
    sourceRunId: bundle.sourceRunId,
    commit: bundle.commit,
    ref: bundle.ref,
    version: bundle.version,
    arch: bundle.arch,
    submissionId: state.id,
    status: "Accepted",
    appStapled: true,
    dmgStapled: true,
    zipPayloadVerified: true,
    files: {},
  };
  for (const file of [bundle.dmg, bundle.zip])
    verification.files[file] = await fileDigest(join(dir, file));
  await writeFile(
    join(dir, "release-verification.json"),
    `${JSON.stringify(verification, null, 2)}\n`,
  );
  console.log(
    `VERIFIED_RELEASE_INSTALLERS ${bundle.arch} ${bundle.version} submission=${state.id}`,
  );
}
