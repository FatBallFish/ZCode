import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuildPlan, validateDependencyPins } from "../build-mikiko-computer-use.mjs";

test("preview builds stay in the ignored Mikiko cache and declare their own permission identity", () => {
  const plan = resolveBuildPlan({ repoRoot: "/fixture/repo", platform: "darwin", arch: "arm64" });
  assert.equal(plan.outputDirectory, "/fixture/repo/.cache/mikiko-computer-use/arm64/release");
  assert.equal(plan.bundleIdentifier, "dev.mikiko.computer-use.development");
  assert.equal(plan.displayName, "Mikiko Computer Use Dev");
  assert.equal(plan.executableName, "mikiko-computer-use");
});

test("unsupported platforms and path-shaped architecture/configuration cannot select an output", () => {
  for (const options of [
    { platform: "linux", arch: "arm64" },
    { platform: "darwin", arch: "../../outside" },
    { platform: "darwin", arch: "arm64", configuration: "../../outside" },
  ])
    assert.throws(() => resolveBuildPlan({ repoRoot: "/fixture/repo", ...options }));
});

test("dependency resolution refuses unreviewed packages and libwebp revision drift", () => {
  const pin = {
    identity: "libwebp-xcode",
    location: "https://github.com/SDWebImage/libwebp-Xcode.git",
    state: { version: "1.6.0", revision: "2b5256c29ff4e20f2a0d5ee863b62b1a22144434" },
  };
  assert.doesNotThrow(() => validateDependencyPins(JSON.stringify({ pins: [pin] })));
  for (const pins of [
    [],
    [pin, { identity: "unreviewed" }],
    [{ ...pin, state: { ...pin.state, revision: "changed" } }],
  ])
    assert.throws(() => validateDependencyPins(JSON.stringify({ pins })));
});
