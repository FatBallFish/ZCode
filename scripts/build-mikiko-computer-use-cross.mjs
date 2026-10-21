#!/usr/bin/env node
/**
 * Mikiko Computer Use Windows/Linux 实验运行时交叉构建器。
 *
 * 与 Swift builder（build-mikiko-computer-use.mjs）共用同一 pinned 上游与
 * provenance 约定，但工具链独立：上游 apps/OpenComputerUse{Windows,Linux} 是
 * Go 程序（内嵌 runtime.ps1 / runtime.py），可用 CGO_ENABLED=0 从 macOS 直接
 * 交叉编译。上游官方声明 Windows/Linux 运行时为实验阶段（docs/ARCHITECTURE.md、
 * docs/releases/github/v1.0.0.md），产物 provenance 必须带 experimental 标记，
 * 打包与设置页据此展示实验标识（docs/specs/computer-use-experimental-platforms.md）。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UPSTREAM } from "./build-mikiko-computer-use.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

const CROSS_APP_SOURCES = {
  win32: "apps/OpenComputerUseWindows",
  linux: "apps/OpenComputerUseLinux",
};
const GOARCH_BY_ARCH = { x64: "amd64", arm64: "arm64" };
const GOOS_BY_OS = { win32: "windows", linux: "linux" };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function run(command, args, { cwd, env = process.env, logPath, timeout = 600_000 } = {}) {
  try {
    const { stdout, stderr } = await new Promise((accept, reject) => {
      const child = execFile(
        command,
        args,
        { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) =>
          error ? reject(Object.assign(error, { stdout, stderr })) : accept({ stdout, stderr }),
      );
      child.stdin?.end();
    });
    if (logPath)
      await appendFile(logPath, `${JSON.stringify([command, ...args])}\n${stdout}\n${stderr}\n`);
    return stdout;
  } catch (error) {
    if (logPath)
      await appendFile(
        logPath,
        `${JSON.stringify([command, ...args])} FAILED\n${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}\n`,
      );
    throw new Error(
      `${command} failed (${error.code ?? error.signal ?? "unknown"}); see ${logPath}`,
      { cause: error },
    );
  }
}

export function resolveCrossBuildPlan(options = {}) {
  const os = options.os ?? "win32";
  const arch = options.arch ?? process.arch;
  const production = options.production === true;
  if (!GOOS_BY_OS[os]) throw new Error("Cross build requires --os win32|linux.");
  if (!GOARCH_BY_ARCH[arch]) throw new Error("Cross build requires --arch x64|arm64.");
  if (options.candidate !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.candidate))
    throw new Error("Candidate requires a simple production cache name.");
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const cacheDirectory = join(repoRoot, ".cache", "mikiko-computer-use");
  const goarch = GOARCH_BY_ARCH[arch];
  return {
    repoRoot,
    cacheDirectory,
    os,
    arch,
    goarch,
    goos: GOOS_BY_OS[os],
    production,
    appSource: CROSS_APP_SOURCES[os],
    executableName:
      os === "win32" ? `mikiko-computer-use-win32-${arch}.exe` : `mikiko-computer-use-${os}-${arch}`,
    outputDirectory: join(
      cacheDirectory,
      "cross",
      ...(production
        ? ["production", ...(options.candidate ? ["candidates", options.candidate] : [])]
        : ["dev"]),
      os,
      goarch,
    ),
  };
}

async function sourcePinnedUpstream(plan, logPath) {
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

async function directoryDigest(directory) {
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
  await visit(directory, ".");
  return sha256(JSON.stringify(hashes));
}

async function prepareCrossWorktree(plan, source, inputDigest, logPath) {
  const work = join(plan.cacheDirectory, "work", `cross-${plan.os}-${inputDigest.slice(0, 16)}`);
  const stampPath = join(work, ".mikiko-cross-source-stamp.json");
  let existing;
  try {
    existing = JSON.parse(await readFile(stampPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.inputDigest !== inputDigest)
      throw new Error(
        `Cached cross source was superseded; remove only this generated directory: ${work}`,
      );
    return { directory: work, sourceDigest: existing.sourceDigest, version: existing.version };
  }
  await mkdir(work, { recursive: true });
  const archivePaths = [
    plan.appSource,
    "plugins/open-computer-use/.codex-plugin/plugin.json",
    "LICENSE",
  ];
  const archive = await run("git", [...source.prefix, "archive", UPSTREAM.commit, ...archivePaths], {
    logPath,
  });
  const archivePath = join(work, ".upstream.tar");
  await writeFile(archivePath, archive);
  try {
    await run("tar", ["-xf", archivePath, "-C", work], { logPath });
  } finally {
    await rm(archivePath, { force: true });
  }
  const plugin = JSON.parse(
    await readFile(join(work, "plugins/open-computer-use/.codex-plugin/plugin.json"), "utf8"),
  );
  const version = String(plugin.version ?? "");
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error("Upstream runtime version is unreadable.");
  const sourceDigest = await directoryDigest(join(work, plan.appSource));
  await writeFile(stampPath, JSON.stringify({ inputDigest, sourceDigest, version }, null, 2));
  return { directory: work, sourceDigest, version };
}

export async function buildMikikoComputerUseCross(options = {}) {
  const plan = resolveCrossBuildPlan(options);
  const builderSha256 = sha256(await readFile(scriptPath));
  await mkdir(plan.cacheDirectory, { recursive: true });
  const lock = join(plan.cacheDirectory, "cross-builder.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Another cross build owns ${lock}; do not run concurrent builders.`);
    throw error;
  }
  const logPath = join(plan.cacheDirectory, `cross-build-${Date.now()}.log`);
  let staging;
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    const goVersion = (await run("go", ["version"], { logPath })).trim();
    if (!/^go version go1\.(?:[2-9][0-9]|[0-9]{3})\b/.test(goVersion))
      throw new Error("Cross build requires Go 1.20+.");
    const inputDigest = sha256(
      JSON.stringify({
        commit: UPSTREAM.commit,
        os: plan.os,
        arch: plan.arch,
        production: plan.production,
        builder: builderSha256,
        go: goVersion,
      }),
    );
    const source = await sourcePinnedUpstream(plan, logPath);
    const work = await prepareCrossWorktree(plan, source, inputDigest, logPath);
    const appDirectory = join(work.directory, plan.appSource);
    await mkdir(plan.cacheDirectory, { recursive: true });
    const buildOutput = join(plan.cacheDirectory, `cross-build-${randomUUID()}`, plan.executableName);
    await mkdir(dirname(buildOutput), { recursive: true });
    console.log(
      `[mikiko-computer-use-cross] Building ${plan.goos}/${plan.goarch} (experimental); log ${logPath}`,
    );
    await run(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags",
        `-s -w -X main.version=${work.version}`,
        "-o",
        buildOutput,
        ".",
      ],
      { cwd: appDirectory, env: { ...process.env, GOOS: plan.goos, GOARCH: plan.goarch, CGO_ENABLED: "0" }, logPath },
    );
    if (options.compileOnly) {
      console.log(JSON.stringify({ compiledOnly: true, executable: buildOutput, logPath }));
      return { ...plan, compiledOnly: true, executable: buildOutput, inputDigest, logPath };
    }
    const executableSha256 = sha256(await readFile(buildOutput));
    const provenance = {
      schemaVersion: 1,
      experimental: true,
      experimentalBasis:
        "Upstream open-computer-use declares Windows/Linux runtimes experimental (docs/ARCHITECTURE.md, docs/releases/github/v1.0.0.md).",
      upstream: UPSTREAM,
      sourceKind: source.kind,
      appSource: plan.appSource,
      patchedSourceSha256: work.sourceDigest,
      buildInputSha256: inputDigest,
      builderSha256,
      go: goVersion,
      target: { os: plan.os, arch: plan.arch, goos: plan.goos, goarch: plan.goarch },
      runtimeVersion: work.version,
      executable: plan.executableName,
      executableSha256,
      signature: "unsigned experimental build; platform runtime requires local OS trust decisions",
      nativeProbe: { skipped: "Cross-compiled binary was not executed on this host." },
      production: plan.production,
    };
    // 原子交换：staging 组装完整目录后整体替换旧产物。
    staging = `${plan.outputDirectory}.staging-${randomUUID()}`;
    await mkdir(staging, { recursive: true });
    await copyFile(buildOutput, join(staging, plan.executableName));
    await writeFile(
      join(staging, "provenance.json"),
      JSON.stringify(provenance, null, 2) + "\n",
    );
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
    await rm(dirname(buildOutput), { recursive: true, force: true });
    console.log(
      JSON.stringify({
        outputDirectory: plan.outputDirectory,
        executable: join(plan.outputDirectory, plan.executableName),
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
    if (process.argv.includes("--help")) {
      console.log(
        "Cross-compile experimental Mikiko Computer Use Windows/Linux runtimes from the pinned upstream.\nOptions: --os win32|linux --arch x64|arm64 --production --compile-only --candidate <cache name>\nOutput: .cache/mikiko-computer-use/cross/<variant>/<os>/<goarch>; unsigned experimental builds.",
      );
    } else {
      const options = {};
      const names = { "--os": "os", "--arch": "arch", "--candidate": "candidate" };
      for (let index = 2; index < process.argv.length; index += 2) {
        if (process.argv[index] === "--production") {
          options.production = true;
          index -= 1;
          continue;
        }
        if (process.argv[index] === "--compile-only") {
          options.compileOnly = true;
          index -= 1;
          continue;
        }
        const name = names[process.argv[index]];
        const value = process.argv[index + 1];
        if (!name || !value || value.startsWith("--"))
          throw new Error(`Invalid argument: ${process.argv[index]}`);
        options[name] = value;
      }
      await buildMikikoComputerUseCross(options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
