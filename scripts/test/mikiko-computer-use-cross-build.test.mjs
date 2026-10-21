import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCrossBuildPlan,
} from "../build-mikiko-computer-use-cross.mjs";
import { validateCrossExperimentalProvenance } from "../../packages/desktop/scripts/mikiko-computer-use-assets.mjs";

test("cross plans select experimental win/linux outputs with executable naming per platform", () => {
  const win = resolveCrossBuildPlan({ repoRoot: "/fixture/repo", os: "win32", arch: "x64", production: true });
  assert.equal(win.goos, "windows");
  assert.equal(win.goarch, "amd64");
  assert.equal(win.executableName, "mikiko-computer-use-win32-x64.exe");
  assert.equal(win.outputDirectory, "/fixture/repo/.cache/mikiko-computer-use/cross/production/win32/amd64");
  const linux = resolveCrossBuildPlan({ repoRoot: "/fixture/repo", os: "linux", arch: "arm64" });
  assert.equal(linux.executableName, "mikiko-computer-use-linux-arm64");
  assert.equal(linux.outputDirectory, "/fixture/repo/.cache/mikiko-computer-use/cross/dev/linux/arm64");
});

test("cross plans refuse other platforms and path-shaped inputs", () => {
  for (const options of [
    { os: "darwin", arch: "arm64" },
    { os: "linux", arch: "../../outside" },
    { os: "../../outside", arch: "x64" },
    { os: "win32", arch: "x64", candidate: "../escape" },
  ])
    assert.throws(() => resolveCrossBuildPlan({ repoRoot: "/fixture/repo", ...options }));
});

test("staging only accepts experimental provenance matching the exact target and hash", () => {
  const proof = {
    experimental: true,
    production: true,
    target: { os: "win32", arch: "x64" },
    executableSha256: "a".repeat(64),
  };
  assert.doesNotThrow(() =>
    validateCrossExperimentalProvenance(proof, "win32", "x64", "a".repeat(64)),
  );
  // 非实验产物、目标漂移、哈希不符均拒绝。
  assert.throws(() =>
    validateCrossExperimentalProvenance({ ...proof, experimental: false }, "win32", "x64", "a".repeat(64)),
  );
  assert.throws(() =>
    validateCrossExperimentalProvenance(proof, "linux", "x64", "a".repeat(64)),
  );
  assert.throws(() =>
    validateCrossExperimentalProvenance(proof, "win32", "arm64", "a".repeat(64)),
  );
  assert.throws(() =>
    validateCrossExperimentalProvenance(proof, "win32", "x64", "b".repeat(64)),
  );
});
