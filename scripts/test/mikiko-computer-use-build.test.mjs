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

test("production uses an isolated stable identity and distributable layout for both mac architectures", () => {
  for (const arch of ["arm64", "x64"]) {
    const plan = resolveBuildPlan({
      repoRoot: "/fixture/repo",
      platform: "darwin",
      arch,
      production: true,
    });
    const nativeArch = arch === "x64" ? "x86_64" : arch;
    assert.equal(
      plan.outputDirectory,
      `/fixture/repo/.cache/mikiko-computer-use/production/${nativeArch}/release`,
    );
    assert.equal(plan.bundleIdentifier, "dev.mikiko.computer-use");
    assert.equal(plan.displayName, "Mikiko Computer Use");
    assert.equal(plan.appVariant, "production");
    assert.equal(plan.socketNamespace, "mikiko-production");
  }
});

test("production refuses debug configuration instead of distributing a development build", () => {
  assert.throws(() =>
    resolveBuildPlan({ platform: "darwin", production: true, configuration: "debug" }),
  );
});

test(
  "native control lease holds until explicit owner cleanup, read-only connections cannot release it",
  { skip: process.platform !== "darwin" },
  async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), "mikiko-native-lease-"));
    try {
      const harness = join(directory, "main.swift");
      await writeFile(
        harness,
        `import Foundation
let lease = MikikoControlLease()
let owner = UUID(), competitor = UUID()
try lease.acquire(owner)
try lease.acquire(owner)
precondition(lease.isBusy)
do { try lease.acquire(competitor); fatalError("competitor acquired") } catch { precondition(String(describing:error).contains("busy")) }
var cleaned = false
lease.release(competitor) { fatalError("read-only connection cleaned another owner") }
precondition(lease.isBusy)
lease.release(owner) {
  cleaned = true
  precondition(lease.isBusy)
  do { try lease.acquire(competitor); fatalError("acquired before cleanup finished") } catch { }
}
precondition(cleaned && !lease.isBusy)
try lease.acquire(competitor)
lease.release(owner) { fatalError("stale owner released replacement") }
precondition(lease.isBusy)
lease.release(competitor) { }
precondition(!lease.isBusy)
print("lease-owner-cleanup-ok")
`,
      );
      const binary = join(directory, "lease-probe");
      await run(
        "swiftc",
        [resolve("scripts/computer-use-native/MikikoControlLease.swift"), harness, "-o", binary],
        { timeout: 60_000 },
      );
      const result = await run(binary, [], { timeout: 10_000 });
      assert.equal(result.stdout.trim(), "lease-owner-cleanup-ok");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("packaging contract rejects wrong native identity, arch, mode or modified executable", async () => {
  const { validateProductionNativeProvenance } =
    await import("../../packages/desktop/scripts/mikiko-computer-use-assets.mjs");
  const proof = {
    production: true,
    bundleIdentifier: "dev.mikiko.computer-use",
    architecture: "arm64",
    minimumMacOS: "14.0",
    appVariant: "production",
    socketNamespace: "mikiko-production",
    executableSha256: "abc",
  };
  assert.doesNotThrow(() => validateProductionNativeProvenance(proof, "arm64", "abc"));
  for (const changed of [
    { production: false },
    { bundleIdentifier: "dev.mikiko.computer-use.development" },
    { architecture: "x86_64" },
    { socketNamespace: "per-client" },
    { executableSha256: "modified" },
  ])
    assert.throws(() =>
      validateProductionNativeProvenance({ ...proof, ...changed }, "arm64", "abc"),
    );
});

test(
  "production shutdown fences future acquisitions and cannot race an active owner",
  { skip: process.platform !== "darwin" },
  async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), "mikiko-native-shutdown-"));
    try {
      const harness = join(directory, "main.swift"),
        binary = join(directory, "shutdown-probe");
      await writeFile(
        harness,
        `import Foundation
let lease=MikikoControlLease(), owner=UUID()
try lease.acquire(owner)
do { try lease.requestShutdown(); fatalError("shutdown stole active lease") } catch { }
lease.release(owner) { }
try lease.requestShutdown()
do { try lease.acquire(UUID()); fatalError("acquired while shutdown pending") } catch { }
print("shutdown-fenced-ok")
`,
      );
      await run(
        "swiftc",
        [resolve("scripts/computer-use-native/MikikoControlLease.swift"), harness, "-o", binary],
        { timeout: 60_000 },
      );
      assert.equal(
        (await run(binary, [], { timeout: 10_000 })).stdout.trim(),
        "shutdown-fenced-ok",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("production candidate output cannot overwrite the authorization baseline or escape its cache", () => {
  const plan = resolveBuildPlan({
    platform: "darwin",
    arch: "arm64",
    repoRoot: "/fixture/repo",
    production: true,
    candidate: "upgrade-acceptance",
  });
  assert.equal(
    plan.outputDirectory,
    "/fixture/repo/.cache/mikiko-computer-use/production/candidates/upgrade-acceptance/arm64/release",
  );
  for (const candidate of ["../outside", "/tmp/app", "Upper Case", ""])
    assert.throws(() => resolveBuildPlan({ platform: "darwin", production: true, candidate }));
});

test("packaging signs the complete native App before writing final byte provenance and fails on signing errors", async () => {
  const { finalizePackagedMikikoComputerUse } =
    await import("../../packages/desktop/scripts/mikiko-computer-use-assets.mjs");
  const { mkdtemp, mkdir, writeFile, readFile, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const directory = await mkdtemp(join(tmpdir(), "mikiko-packaging-contract-"));
  try {
    const resources = join(directory, "Mikiko.app/Contents/Resources/computer-use");
    const app = join(resources, "Mikiko Computer Use.app");
    const binary = join(app, "Contents/MacOS/mikiko-computer-use");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(binary, "native-fixture");
    const sourceHash = digest(await readFile(binary));
    await writeFile(
      join(resources, "provenance.json"),
      JSON.stringify({
        production: true,
        bundleIdentifier: "dev.mikiko.computer-use",
        architecture: "arm64",
        minimumMacOS: "14.0",
        appVariant: "production",
        socketNamespace: "mikiko-production",
        executableSha256: sourceHash,
        buildInputSha256: "fixture-build",
      }),
    );
    await writeFile(join(resources, "production-server.mjs"), "gateway-fixture");
    await writeFile(
      join(resources, "gateway-provenance.json"),
      JSON.stringify({ sha256: digest("gateway-fixture") }),
    );
    const calls = [];
    const execFileImpl = async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith("lipo")) return { stdout: "arm64\n", stderr: "" };
      if (command.endsWith("PlistBuddy"))
        return { stdout: "dev.mikiko.computer-use\n", stderr: "" };
      if (args.includes("--sign") && args.at(-1) === binary)
        await writeFile(binary, "signed-native-fixture");
      return {
        stdout: "",
        stderr:
          "Identifier=dev.mikiko.computer-use\nTeamIdentifier=FIXTURETEAM\nTimestamp=fixture-time\nCodeDirectory v=20500 flags=0x10000(runtime)\n",
      };
    };
    const context = {
      electronPlatformName: "darwin",
      appOutDir: directory,
      packager: { appInfo: { productFilename: "Mikiko" } },
    };
    if (process.platform !== "win32") {
      const license = join(app, "Contents/Resources/LICENSE.libwebp.txt");
      await mkdir(join(app, "Contents/Resources"));
      await writeFile(license, "Synthetic readonly dependency license");
      await chmod(license, 0o444);
      await assert.rejects(
        finalizePackagedMikikoComputerUse(context, {
          arch: "arm64",
          identity: "fixture-identity",
          execFileImpl,
        }),
        /owner-writable.*LICENSE.libwebp.txt/,
      );
      assert.equal(
        calls.filter(([, args]) => args.includes("--sign")).length,
        0,
        "Readonly resources must be rejected before any signature is written",
      );
      await chmod(license, 0o644);
    }
    await finalizePackagedMikikoComputerUse(context, {
      arch: "arm64",
      identity: "fixture-identity",
      execFileImpl,
    });
    const signed = calls.filter(([, args]) => args.includes("--sign"));
    assert.equal(signed.length, 2);
    assert.deepEqual(
      signed.map(([, args]) => args.at(-1)),
      [binary, app],
    );
    for (const [, args] of signed) {
      assert.ok(args.includes("--timestamp"));
      assert.ok(args.includes("runtime"));
    }
    assert.ok(
      calls.some(
        ([, args]) =>
          args.includes("--verify") &&
          args.some((arg) => arg.startsWith('=identifier "dev.mikiko.computer-use"')),
      ),
    );
    const proof = JSON.parse(await readFile(join(resources, "signing-provenance.json"), "utf8"));
    assert.equal(proof.sourceExecutableSha256, sourceHash);
    assert.equal(proof.packagedExecutableSha256, digest("signed-native-fixture"));
    await writeFile(binary, "native-fixture");
    await rm(join(resources, "signing-provenance.json"));
    await assert.rejects(
      finalizePackagedMikikoComputerUse(context, {
        arch: "arm64",
        identity: "fixture-identity",
        execFileImpl: async (command, args) => {
          if (command.endsWith("codesign")) throw new Error("fixture signing failure");
          return execFileImpl(command, args);
        },
      }),
      /fixture signing failure/,
    );
    await assert.rejects(
      readFile(join(resources, "signing-provenance.json")),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "native last-connection shutdown is atomic and preserves other clients",
  { skip: process.platform !== "darwin" },
  async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const dir = await mkdtemp(join(tmpdir(), "mikiko-native-lifetime-"));
    try {
      const main = join(dir, "main.swift");
      await writeFile(
        main,
        `import Foundation
let lease = MikikoControlLease()
let a = UUID(), b = UUID(), late = UUID()
precondition(lease.registerConnection(a))
precondition(lease.registerConnection(b))
try lease.acquire(a)
precondition(!lease.closeConnection(b) { fatalError("observer cleaned owner") })
precondition(lease.isBusy)
var cleaned = false
precondition(lease.closeConnection(a) { cleaned = true; precondition(lease.isBusy) })
precondition(cleaned)
precondition(!lease.registerConnection(late))
do { try lease.acquire(late); fatalError("admitted after last EOF") } catch {}
precondition(!lease.closeConnection(a) {})
print("last-connection-shutdown-ok")
`,
      );
      const binary = join(dir, "probe");
      await promisify(execFile)("swiftc", [
        resolve("scripts/computer-use-native/MikikoControlLease.swift"),
        main,
        "-o",
        binary,
      ]);
      assert.match((await promisify(execFile)(binary, [])).stdout, /last-connection-shutdown-ok/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
