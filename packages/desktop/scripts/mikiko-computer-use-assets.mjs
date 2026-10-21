/** 正式 OCU 资源链：缺失、身份/架构不符或签名失败一律停止打包。 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { assertMacBundleOwnerWrite } from "../../../scripts/macos-bundle-permissions.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const nativeAppName = "Mikiko Computer Use.app";
export const nativeBundleIdentifier = "dev.mikiko.computer-use";

export function validateProductionNativeProvenance(proof, arch, executableSha256) {
  const expectedArch = arch === "x64" ? "x86_64" : arch;
  if (
    !proof.production ||
    proof.bundleIdentifier !== nativeBundleIdentifier ||
    proof.architecture !== expectedArch ||
    proof.minimumMacOS !== "14.0" ||
    proof.appVariant !== "production" ||
    proof.socketNamespace !== "mikiko-production" ||
    proof.executableSha256 !== executableSha256
  )
    throw new Error("Mikiko production native provenance identity/architecture/hash mismatch.");
}

export async function stageMikikoComputerUseResources({ repoRoot, arch }) {
  if (!["arm64", "x64"].includes(arch))
    throw new Error("Unsupported Computer Use target architecture.");
  const nativeArch = arch === "x64" ? "x86_64" : arch;
  const source = join(repoRoot, ".cache/mikiko-computer-use/production", nativeArch, "release");
  const destination = join(
    repoRoot,
    "packages/desktop/bundled-tools",
    `darwin-${arch}`,
    "mikiko-computer-use",
  );
  const binary = join(source, nativeAppName, "Contents/MacOS/mikiko-computer-use");
  const proof = JSON.parse(await readFile(join(source, "provenance.json"), "utf8"));
  validateProductionNativeProvenance(proof, arch, hash(await readFile(binary)));
  await assertMacBundleOwnerWrite(join(source, nativeAppName));
  await execute("/usr/bin/codesign", ["--verify", "--strict", join(source, nativeAppName)]);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(source, nativeAppName), join(destination, nativeAppName), { recursive: true });
  const packagedProof = { ...proof };
  delete packagedProof.localSigningMetadata;
  if (packagedProof.nativeProbe?.permissions)
    packagedProof.nativeProbe = { permissionsAreDiagnosticOnly: true, nativeActionsInvoked: false };
  await writeFile(
    join(destination, "provenance.json"),
    JSON.stringify(packagedProof, null, 2) + "\n",
  );
  const esbuild = require("esbuild");
  const result = await esbuild.build({
    entryPoints: [join(repoRoot, "packages/computer-use-open/dist/production-server.js")],
    outfile: join(destination, "production-server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true,
    banner: {
      js: 'import { createRequire as __mikikoCreateRequire } from "node:module"; const require = __mikikoCreateRequire(import.meta.url);',
    },
  });
  // 外部运行时依赖只能是 Node 内建模块；不允许开发机 node_modules 恰好存在掩盖坏包。
  const { isBuiltin } = await import("node:module");
  for (const output of Object.values(result.metafile.outputs))
    for (const entry of output.imports)
      if (entry.external && !isBuiltin(entry.path))
        throw new Error(`Unbundled Computer Use dependency: ${entry.path}`);
  await writeFile(
    join(destination, "gateway-provenance.json"),
    JSON.stringify(
      {
        schema: 1,
        server: "production-server.mjs",
        sha256: hash(await readFile(join(destination, "production-server.mjs"))),
        sources: Object.keys(result.metafile.inputs).sort(),
        externalDependencies: "Node built-ins only",
      },
      null,
      2,
    ) + "\n",
  );
  return destination;
}

export async function finalizePackagedMikikoComputerUse(context, options = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const product = context.packager?.appInfo?.productFilename ?? "Mikiko";
  const root = resolve(context.appOutDir, `${product}.app/Contents/Resources/computer-use`);
  const app = join(root, nativeAppName);
  const binary = join(app, "Contents/MacOS/mikiko-computer-use");
  const proof = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
  validateProductionNativeProvenance(proof, options.arch, hash(await readFile(binary)));
  const run = options.execFileImpl ?? execute;
  const targetArch = options.arch === "x64" ? "x86_64" : options.arch;
  const { stdout: actualArch } = await run("/usr/bin/lipo", ["-archs", binary]);
  if (actualArch.trim() !== targetArch)
    throw new Error("Packaged Computer Use architecture mismatch.");
  const { stdout: bundleId } = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    join(app, "Contents/Info.plist"),
  ]);
  if (bundleId.trim() !== nativeBundleIdentifier)
    throw new Error("Packaged Computer Use bundle identity mismatch.");
  const gateway = JSON.parse(await readFile(join(root, "gateway-provenance.json"), "utf8"));
  if (hash(await readFile(join(root, "production-server.mjs"))) !== gateway.sha256)
    throw new Error("Packaged Computer Use gateway hash mismatch.");
  // 旧签名缓存或复制阶段引入只读文件时，必须在签名前拒绝，不能留给ShipIt安装时失败。
  await assertMacBundleOwnerWrite(app);
  if (options.identity) {
    for (const target of [binary, app])
      await run(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          options.identity,
          "--timestamp",
          "--options",
          "runtime",
          ...(process.env.CSC_KEYCHAIN ? ["--keychain", process.env.CSC_KEYCHAIN] : []),
          target,
        ],
        { timeout: 120_000, killSignal: "SIGKILL" },
      );
    await run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--deep",
      "-R",
      `=identifier "${nativeBundleIdentifier}" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`,
      app,
    ]);
  } else {
    if (process.env.CI === "true")
      throw new Error("Release Computer Use requires Developer ID signing.");
    await run("/usr/bin/codesign", ["--verify", "--strict", app]);
  }
  const signature = await run("/usr/bin/codesign", ["--display", "--verbose=4", app]);
  const signingMetadata = {
    identifier: /^Identifier=(.+)$/m.exec(signature.stderr)?.[1] ?? null,
    teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(signature.stderr)?.[1] ?? null,
    timestamp: /^Timestamp=(.+)$/m.exec(signature.stderr)?.[1] ?? null,
    hardenedRuntime: /flags=0x[0-9a-f]+\(runtime\)/i.test(signature.stderr),
  };
  if (
    options.identity &&
    (!signingMetadata.timestamp ||
      !signingMetadata.hardenedRuntime ||
      signingMetadata.identifier !== nativeBundleIdentifier)
  )
    throw new Error("Computer Use signature lacks required runtime/timestamp/identity.");
  await writeFile(
    join(root, "signing-provenance.json"),
    JSON.stringify(
      {
        schema: 1,
        bundleIdentifier: nativeBundleIdentifier,
        architecture: targetArch,
        nativeBuildInput: proof.buildInputSha256,
        sourceExecutableSha256: proof.executableSha256,
        packagedExecutableSha256: hash(await readFile(binary)),
        developerIdSigned: Boolean(options.identity),
        notarization: "included in parent App notarization",
        codesign: signingMetadata,
      },
      null,
      2,
    ) + "\n",
  );
}
