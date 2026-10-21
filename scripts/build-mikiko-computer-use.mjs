#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
export const UPSTREAM = Object.freeze({
  url: "https://github.com/iFurySt/open-computer-use.git",
  commit: "43eb4b53de7a15b3f99ec2c9922bedeb95602266",
  libwebpUrl: "https://github.com/SDWebImage/libwebp-Xcode.git",
  libwebpVersion: "1.6.0",
  libwebpRevision: "2b5256c29ff4e20f2a0d5ee863b62b1a22144434",
});
const sourceDirectories = [
  "apps/OpenComputerUse/Sources",
  "apps/OpenComputerUseFixture/Sources",
  "apps/OpenComputerUseSmokeSuite/Sources",
  "packages/OpenComputerUseKit/Sources",
  "packages/OpenComputerUseKit/Tests",
  "packages/OpenComputerUseVirtualDisplayShim",
  "packages/LockedUseNative",
  "experiments/LockedUse/Sources",
  "experiments/CursorMotion/Sources",
  "experiments/StandaloneCursor/Sources",
  "experiments/StandaloneCursor/Tests",
];
const sourcePaths = [
  "Package.swift",
  "Package.resolved",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ...sourceDirectories,
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function resolveBuildPlan(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const configuration = options.configuration ?? "release";
  const production = options.production === true;
  if (
    options.candidate !== undefined &&
    (!production || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.candidate))
  )
    throw new Error("Candidate requires a simple production cache name.");
  if (production && configuration !== "release")
    throw new Error("Production requires release configuration.");
  if (platform !== "darwin")
    throw new Error("Mikiko native preview requires macOS 14+ and Swift 6.2.");
  if (!["arm64", "x86_64", "x64"].includes(arch))
    throw new Error("Unsupported native architecture.");
  if (!["debug", "release"].includes(configuration))
    throw new Error("Invalid build configuration.");
  const nativeArch = arch === "x64" ? "x86_64" : arch;
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const cacheDirectory = join(repoRoot, ".cache", "mikiko-computer-use");
  return {
    repoRoot,
    cacheDirectory,
    arch: nativeArch,
    configuration,
    production,
    appVariant: production ? "production" : "dev",
    socketNamespace: production ? "mikiko-production" : null,
    outputDirectory: join(
      cacheDirectory,
      ...(production
        ? ["production", ...(options.candidate ? ["candidates", options.candidate] : [])]
        : []),
      nativeArch,
      configuration,
    ),
    bundleIdentifier: production
      ? "dev.mikiko.computer-use"
      : "dev.mikiko.computer-use.development",
    displayName: production ? "Mikiko Computer Use" : "Mikiko Computer Use Dev",
    executableName: "mikiko-computer-use",
  };
}

export function validateDependencyPins(text) {
  const { pins } = JSON.parse(text);
  const pin = pins?.[0];
  if (
    pins?.length !== 1 ||
    pin?.identity !== "libwebp-xcode" ||
    pin.location !== UPSTREAM.libwebpUrl ||
    pin.state?.version !== UPSTREAM.libwebpVersion ||
    pin.state?.revision !== UPSTREAM.libwebpRevision
  )
    throw new Error(
      "Unreviewed upstream dependency resolution; expected the pinned libwebp 1.6.0 revision.",
    );
}

async function run(
  command,
  args,
  { cwd, env = process.env, input = "", binary = false, logPath, timeout = 600_000 } = {},
) {
  let child;
  const result = await new Promise((accept, reject) => {
    child = execFile(
      command,
      args,
      { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: binary ? null : "utf8" },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : accept({ stdout, stderr }),
    );
    child.stdin?.on("error", (error) => {
      if (error.code !== "EPIPE") child.kill();
    });
    child.stdin?.end(input);
  }).catch(async (error) => {
    if (logPath)
      await appendFile(
        logPath,
        `${JSON.stringify([command, ...args])}\n${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}\n`,
      );
    throw new Error(
      `${command} failed (${error.code ?? error.signal ?? "unknown"}); ${logPath ? `see ${logPath}` : String(error.stderr ?? error.message)}`,
      { cause: error },
    );
  });
  if (logPath)
    await appendFile(
      logPath,
      `${JSON.stringify([command, ...args])}\n${binary ? `[binary stdout ${result.stdout.length} bytes]` : result.stdout}\n${result.stderr}\n`,
    );
  return result.stdout;
}

async function sourceRepository(plan, sourceDirectory, logPath) {
  if (sourceDirectory) {
    const cwd = resolve(sourceDirectory);
    const commit = (await run("git", ["rev-parse", "HEAD"], { cwd })).trim();
    const remote = (await run("git", ["remote", "get-url", "origin"], { cwd })).trim();
    if (
      commit !== UPSTREAM.commit ||
      remote.replace(/\.git$/, "").toLowerCase() !==
        UPSTREAM.url.replace(/\.git$/, "").toLowerCase()
    )
      throw new Error(
        "Local source must be the exact reviewed commit from the canonical upstream remote.",
      );
    await run("git", ["diff", "--exit-code", "HEAD", "--"], { cwd, logPath });
    return { cwd, prefix: [], kind: "verified-local-git" };
  }
  const bare = join(plan.cacheDirectory, "upstream.git");
  await mkdir(bare, { recursive: true });
  await run("git", ["init", "--bare", bare], { logPath });
  const prefix = ["--git-dir", bare];
  try {
    await run("git", [...prefix, "cat-file", "-e", `${UPSTREAM.commit}^{commit}`]);
  } catch {
    await run(
      "git",
      [...prefix, "fetch", "--depth=1", "--no-tags", UPSTREAM.url, UPSTREAM.commit],
      { logPath },
    );
  }
  if (
    (await run("git", [...prefix, "rev-parse", `${UPSTREAM.commit}^{commit}`])).trim() !==
    UPSTREAM.commit
  )
    throw new Error("Upstream source commit verification failed.");
  return { prefix, kind: "pinned-canonical-fetch" };
}

async function sourceDigest(directory) {
  const hashes = [];
  async function visit(path, relative) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), name);
      else if (entry.isFile()) hashes.push([name, sha256(await readFile(join(path, entry.name)))]);
      else throw new Error(`Unexpected source link or special file: ${name}`);
    }
  }
  for (const path of sourcePaths) {
    if (sourceDirectories.includes(path)) await visit(join(directory, path), path);
    else hashes.push([path, sha256(await readFile(join(directory, path)))]);
  }
  return sha256(JSON.stringify(hashes));
}

async function prepareWorktree(plan, source, inputDigest, patches, logPath) {
  const work = join(plan.cacheDirectory, "work", inputDigest);
  const stampPath = join(work, ".mikiko-source-stamp.json");
  let existing;
  try {
    existing = JSON.parse(await readFile(stampPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (
      existing.inputDigest !== inputDigest ||
      existing.sourceDigest !== (await sourceDigest(work))
    )
      throw new Error(
        `Cached source was modified; remove only this generated work directory: ${work}`,
      );
    return { directory: work, sourceDigest: existing.sourceDigest };
  }
  await mkdir(work, { recursive: true });
  const archive = await run("git", [...source.prefix, "archive", UPSTREAM.commit, ...sourcePaths], {
    cwd: source.cwd,
    binary: true,
    logPath,
  });
  const archivePath = join(work, ".upstream.tar");
  await writeFile(archivePath, archive);
  try {
    await run("tar", ["-xf", archivePath, "-C", work], { logPath });
  } finally {
    await rm(archivePath, { force: true });
  }
  validateDependencyPins(await readFile(join(work, "Package.resolved"), "utf8"));
  // 独立 Git 根避免补丁写入外层仓库；生产追加补丁不改已冻结预览源码或签名。
  await run("git", ["init", work], { logPath });
  for (const [index, patch] of patches.entries()) {
    const patchPath = join(work, `.mikiko-${index}.patch`);
    await writeFile(patchPath, patch);
    await run("git", ["apply", "--check", patchPath], { cwd: work, logPath });
    await run("git", ["apply", patchPath], { cwd: work, logPath });
  }
  if (plan.production)
    await copyFile(
      join(plan.repoRoot, "scripts/computer-use-native/MikikoControlLease.swift"),
      join(work, "apps/OpenComputerUse/Sources/OpenComputerUse/MikikoControlLease.swift"),
    );
  if (plan.production)
    await copyFile(
      join(plan.repoRoot, "scripts/computer-use-native/ScreenshotCaptureAvailabilityTests.swift"),
      join(
        work,
        "packages/OpenComputerUseKit/Tests/OpenComputerUseKitTests/ScreenshotCaptureAvailabilityTests.swift",
      ),
    );
  if (plan.production) {
    for (const [name, folder] of [
      ["MikikoAXAction.swift", "Sources/OpenComputerUseKit"],
      ["MikikoDrag.swift", "Sources/OpenComputerUseKit"],
      ["MikikoDragTests.swift", "Tests/OpenComputerUseKitTests"],
      ["MikikoAXActionTests.swift", "Tests/OpenComputerUseKitTests"],
    ])
      await copyFile(
        join(plan.repoRoot, "scripts/computer-use-native", name),
        join(work, "packages/OpenComputerUseKit", folder, name),
      );
  }
  const digest = await sourceDigest(work);
  await writeFile(stampPath, JSON.stringify({ inputDigest, sourceDigest: digest }, null, 2));
  return { directory: work, sourceDigest: digest };
}

function infoPlist(plan, buildIdentifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${plan.executableName}</string>
<key>CFBundleIdentifier</key><string>${plan.bundleIdentifier}</string>
<key>CFBundleName</key><string>${plan.displayName}</string>
<key>CFBundleDisplayName</key><string>${plan.displayName}</string>
<key>CFBundleIconFile</key><string>MikikoComputerUse.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>MikikoComputerUseAppVariant</key><string>${plan.appVariant}</string>
<key>MikikoComputerUseBuildIdentifier</key><string>${buildIdentifier}</string>
</dict></plist>\n`;
}

async function probe(executable, directory, logPath) {
  const home = join(directory, "probe-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("OPEN_COMPUTER_USE_") && !key.startsWith("MIKIKO_COMPUTER_USE_"),
    ),
  );
  Object.assign(env, {
    MIKIKO_COMPUTER_USE_CONFIG_FILE: join(home, "config.json"),
    MIKIKO_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: "1",
    MIKIKO_COMPUTER_USE_VISUAL_CURSOR: "1",
    MIKIKO_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: "1",
  });
  const help = await run(executable, ["--help"], { env, logPath, timeout: 15_000 });
  if (!help.includes("mikiko-computer-use")) throw new Error("Unbranded native help output.");
  const permissions = JSON.parse(
    await run(executable, ["doctor", "--json"], { env, logPath, timeout: 15_000 }),
  );
  const request =
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mikiko-build-probe", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  const messages = (
    await run(executable, ["mcp"], { env, input: request, logPath, timeout: 15_000 })
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const initialized = messages.find((message) => message.id === 1)?.result;
  const tools = messages.find((message) => message.id === 2)?.result?.tools;
  if (initialized?.serverInfo?.name !== "mikiko-computer-use" || tools?.length !== 11)
    throw new Error("Branded native MCP discovery failed.");
  await rm(home, { recursive: true, force: true });
  return {
    serverInfo: initialized.serverInfo,
    protocolVersion: initialized.protocolVersion,
    tools: tools.map((tool) => tool.name),
    permissions,
    permissionsAreDiagnosticOnly: true,
    appAgentProxyActivated: false,
    nativeActionsInvoked: false,
    visualCursorEnvironmentCannotEnablePreview: true,
  };
}

export async function buildMikikoComputerUse(options = {}) {
  const plan = resolveBuildPlan(options);
  const signingIdentity = plan.production
    ? (options.signingIdentity ??
      process.env.MIKIKO_COMPUTER_USE_SIGN_IDENTITY ??
      (process.env.MIKIKO_ENABLE_MAC_SIGN === "1"
        ? process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME
        : undefined))
    : undefined;
  if (plan.production && process.env.CI === "true" && !signingIdentity)
    throw new Error(
      "CI production native builds require an explicit Developer ID signing identity.",
    );
  const builderSha256 = sha256(await readFile(scriptPath));
  const jobs = options.jobs ?? 4;
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32)
    throw new Error("jobs must be an integer from 1 to 32.");
  await mkdir(plan.cacheDirectory, { recursive: true });
  const lock = join(plan.cacheDirectory, "builder.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Another build owns ${lock}; do not run concurrent builders.`);
    throw error;
  }
  const logPath = join(plan.cacheDirectory, `build-${Date.now()}.log`);
  let staging;
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    const resources = join(plan.repoRoot, "scripts", "computer-use-native");
    const patches = [await readFile(join(resources, "mikiko-preview.patch"))];
    if (plan.production) patches.push(await readFile(join(resources, "mikiko-production.patch")));
    const patch = Buffer.concat(patches);
    const leaseSource = plan.production
      ? sha256(await readFile(join(resources, "MikikoControlLease.swift")))
      : null;
    const resourceHashes = Object.fromEntries(
      await Promise.all(
        [
          "UPSTREAM-LICENSE.txt",
          "THIRD-PARTY-NOTICES.md",
          "NOTICE.md",
          ...(plan.production
            ? [
                "ScreenshotCaptureAvailabilityTests.swift",
                "MikikoAXAction.swift",
                "MikikoAXActionTests.swift",
                "MikikoDrag.swift",
                "MikikoDragTests.swift",
              ]
            : []),
        ].map(async (name) => [name, sha256(await readFile(join(resources, name)))]),
      ),
    );
    const icon = join(plan.repoRoot, "packages", "desktop", "build", "icon.icns");
    const swift = (await run("swift", ["--version"], { logPath })).trim();
    if (
      !(
        plan.production ? /Swift version 6\.2(?:\.|\b)/ : /Swift version 6\.(?:[2-9]|[1-9][0-9])\b/
      ).test(swift)
    )
      throw new Error(
        "The reviewed Swift 6.2 toolchain is required for production (preview supports Swift 6.2+).",
      );
    const inputDigest = sha256(
      JSON.stringify({
        commit: UPSTREAM.commit,
        patch: sha256(patch),
        leaseSource,
        production: plan.production,
        resourceHashes,
        swift,
        arch: plan.arch,
        configuration: plan.configuration,
        builder: builderSha256,
        icon: sha256(await readFile(icon)),
      }),
    );
    const source = await sourceRepository(plan, options.sourceDirectory, logPath);
    const work = await prepareWorktree(plan, source, inputDigest, patches, logPath);
    const swiftArgs = [
      "build",
      "--product",
      "OpenComputerUse",
      "-c",
      plan.configuration,
      "--triple",
      `${plan.arch}-apple-macosx14.0`,
      "-j",
      String(jobs),
      "--cache-path",
      join(plan.cacheDirectory, "swift-cache"),
      "--config-path",
      join(plan.cacheDirectory, "swift-config"),
      "--security-path",
      join(plan.cacheDirectory, "swift-security"),
      "--disable-keychain",
      "--disable-netrc",
      "--force-resolved-versions",
      "--manifest-cache",
      "local",
    ];
    console.log(
      `[mikiko-computer-use] Building ${plan.arch}/${plan.configuration}; log ${logPath}`,
    );
    await run("swift", swiftArgs, { cwd: work.directory, logPath });
    if (plan.production && plan.arch === (process.arch === "x64" ? "x86_64" : process.arch)) {
      await run(
        "swift",
        [
          "test",
          ...swiftArgs.slice(3),
          "--filter",
          "ScreenshotCaptureAvailabilityTests|MikikoAXActionTests|MikikoDragTests",
        ],
        { cwd: work.directory, logPath },
      );
    }
    const binaryDirectory = (
      await run("swift", [...swiftArgs, "--show-bin-path"], { cwd: work.directory, logPath })
    ).trim();
    const dependency = join(work.directory, ".build", "checkouts", "libwebp-Xcode");
    if (
      (await run("git", ["rev-parse", "HEAD"], { cwd: dependency })).trim() !==
      UPSTREAM.libwebpRevision
    )
      throw new Error("Built libwebp checkout does not match the reviewed revision.");
    if (options.compileOnly) {
      console.log(
        JSON.stringify({
          compiledOnly: true,
          sourceDirectory: work.directory,
          buildInputSha256: inputDigest,
          binaryDirectory,
          logPath,
        }),
      );
      return {
        ...plan,
        compiledOnly: true,
        sourceDirectory: work.directory,
        binaryDirectory,
        inputDigest,
        logPath,
      };
    }
    await mkdir(dirname(plan.outputDirectory), { recursive: true });
    staging = `${plan.outputDirectory}.staging-${randomUUID()}`;
    const app = join(staging, `${plan.displayName}.app`);
    const contents = join(app, "Contents");
    const bundleResources = join(contents, "Resources");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(bundleResources);
    const executable = join(contents, "MacOS", plan.executableName);
    await copyFile(join(binaryDirectory, "OpenComputerUse"), executable);
    await copyFile(icon, join(bundleResources, "MikikoComputerUse.icns"));
    await copyFile(
      join(resources, "UPSTREAM-LICENSE.txt"),
      join(bundleResources, "LICENSE.open-computer-use.txt"),
    );
    await copyFile(
      join(resources, "THIRD-PARTY-NOTICES.md"),
      join(bundleResources, "THIRD-PARTY-NOTICES.md"),
    );
    await copyFile(join(resources, "NOTICE.md"), join(bundleResources, "NOTICE.mikiko.md"));
    await copyFile(join(dependency, "LICENSE"), join(bundleResources, "LICENSE.libwebp.txt"));
    await writeFile(join(contents, "Info.plist"), infoPlist(plan, inputDigest));
    await run("plutil", ["-lint", join(contents, "Info.plist")], { logPath });
    await run(
      "codesign",
      [
        "--force",
        "--sign",
        signingIdentity ?? "-",
        ...(signingIdentity ? ["--timestamp", "--options", "runtime"] : ["--timestamp=none"]),
        ...(signingIdentity && process.env.CSC_KEYCHAIN
          ? ["--keychain", process.env.CSC_KEYCHAIN]
          : []),
        "--identifier",
        plan.bundleIdentifier,
        app,
      ],
      { logPath },
    );
    await run("codesign", ["--verify", "--strict", "--verbose=2", app], { logPath });
    const architectures = (await run("lipo", ["-archs", executable], { logPath }))
      .trim()
      .split(/\s+/);
    if (architectures.length !== 1 || architectures[0] !== plan.arch)
      throw new Error("Native architecture does not match target.");
    const nativeProbe =
      plan.arch === (process.arch === "x64" ? "x86_64" : process.arch)
        ? plan.production
          ? {
              pending:
                "Run doctor through the final Developer-ID-signed App-agent during acceptance; builder never activates a production permission owner.",
              appAgentProxyActivated: false,
              nativeActionsInvoked: false,
            }
          : await probe(executable, staging, logPath)
        : { skipped: "Cross-compiled binary was not executed." };
    const provenance = {
      schemaVersion: 1,
      upstream: UPSTREAM,
      sourceKind: source.kind,
      patchedSourceSha256: work.sourceDigest,
      patchSha256: sha256(patch),
      resourceHashes: {
        ...resourceHashes,
        "LICENSE.libwebp.txt": sha256(await readFile(join(dependency, "LICENSE"))),
        "MikikoComputerUse.icns": sha256(await readFile(icon)),
      },
      buildInputSha256: inputDigest,
      builderSha256,
      swift,
      architecture: plan.arch,
      configuration: plan.configuration,
      minimumMacOS: "14.0",
      bundleIdentifier: plan.bundleIdentifier,
      executable: `${plan.displayName}.app/Contents/MacOS/${plan.executableName}`,
      executableSha256: sha256(await readFile(executable)),
      signature: plan.production
        ? signingIdentity
          ? "Developer ID; hardened runtime and secure timestamp, notarization pending"
          : "ad-hoc staging only; never activated; release packaging requires Developer ID before first launch"
        : "ad-hoc local preview; no Developer ID or notarization",
      production: plan.production,
      appVariant: plan.appVariant,
      socketNamespace: plan.socketNamespace,
      controlLeaseSourceSha256: leaseSource,
      signingDeferredToElectronBuilder: plan.production && !signingIdentity,
      excluded: [
        "upstream cursor artwork and source fallback",
        "global pointer fallback",
        "sky input",
        "virtual display placement",
        "Locked Use private RPC and service installation",
      ],
      nativeProbe,
    };
    await writeFile(join(staging, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
    const previous = `${plan.outputDirectory}.previous-${randomUUID()}`;
    let hadPrevious = false;
    try {
      await rename(plan.outputDirectory, previous);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, plan.outputDirectory);
      staging = undefined;
    } catch (error) {
      if (hadPrevious) await rename(previous, plan.outputDirectory);
      throw error;
    }
    if (hadPrevious) await rm(previous, { recursive: true, force: true });
    console.log(
      JSON.stringify({
        outputDirectory: plan.outputDirectory,
        app: join(plan.outputDirectory, `${plan.displayName}.app`),
        provenance: join(plan.outputDirectory, "provenance.json"),
        logPath,
      }),
    );
    return { ...plan, logPath, provenance };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv.includes("--help"))
      console.log(
        "Build pinned Mikiko macOS Computer Use.\nOptions: --production (stable distributable App identity) --configuration debug|release --arch arm64|x86_64 --jobs 1..32 --source-dir <verified upstream checkout> --sign-identity <Developer ID identity> --compile-only --candidate <isolated production cache name>\nOutput: .cache/mikiko-computer-use/<arch>/<configuration>; no user settings, app-agent activation or services are installed.",
      );
    else {
      const options = {};
      const names = {
        "--configuration": "configuration",
        "--arch": "arch",
        "--jobs": "jobs",
        "--source-dir": "sourceDirectory",
        "--sign-identity": "signingIdentity",
        "--candidate": "candidate",
      };
      for (let index = 2; index < process.argv.length; index += 2) {
        if (["--production", "--compile-only"].includes(process.argv[index])) {
          options[process.argv[index] === "--production" ? "production" : "compileOnly"] = true;
          index -= 1;
          continue;
        }
        const name = names[process.argv[index]];
        const value = process.argv[index + 1];
        if (!name || !value || value.startsWith("--"))
          throw new Error(`Invalid argument: ${process.argv[index]}`);
        options[name] = name === "jobs" ? Number(value) : value;
      }
      await buildMikikoComputerUse(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
