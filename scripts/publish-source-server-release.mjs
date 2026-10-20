#!/usr/bin/env node
/** 自建 Source Server 发布：pnpm publish:source-server-release --dist <artifact> --version <version>。 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createRequire } from "node:module";
import { createUpdatePublishTransport } from "./update-publish-transport.mjs";

// 根脚本不声明产品运行依赖；从发行 owner 的 package 范围解析公开入口，避免跨包实现导入。
const ownerRequire = createRequire(
  new URL("../packages/zcode-server-cli/package.json", import.meta.url),
);
const publicContract = (specifier) => import(pathToFileURL(ownerRequire.resolve(specifier)).href);
const {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
} = await publicContract("@zcode/shared/source-server/release");
const { serverRuntimeManifestSchema } = await publicContract("@zcode/server-cli/runtime-manifest");
const { releaseCatalogSchema } = await publicContract("@zcode/server-cli/release-catalog");

const exec = promisify(execFile);
const RELEASE_PREFIX = "mikiko/electron/releases";
const CATALOG_KEY = "mikiko/server/catalog.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function objectUrl(origin, key) {
  return `${origin.replace(/\/+$/u, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function safeRelativePath(path) {
  return (
    typeof path === "string" &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

async function readArtifact(directory, relativePath) {
  if (!safeRelativePath(relativePath))
    throw new Error(`Unsafe release artifact path: ${relativePath}`);
  const path = await realpath(join(directory, relativePath));
  if (!path.startsWith(`${directory}${sep}`))
    throw new Error(`Release artifact escapes build directory: ${relativePath}`);
  return readFile(path);
}

function validateBuildIdentity(value, version, expectedBuild) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.version !== version ||
    value.tag !== `v${version}` ||
    !/^\d+$/u.test(value.sourceRunId ?? "") ||
    !/^[a-f0-9]{40}$/iu.test(value.commit ?? "") ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "version", "sourceRunId", "commit", "tag"].includes(key),
    )
  ) {
    throw new Error("Invalid Source Server build identity");
  }
  for (const key of ["sourceRunId", "commit", "tag"]) {
    if (expectedBuild?.[key] !== undefined && value[key] !== expectedBuild[key]) {
      throw new Error(`Source Server build identity mismatch: ${key}`);
    }
  }
  return value;
}

/** 同一已验证 descriptor/归档集合投影两个消费索引，不另行选择版本。 */
export async function prepareSourceServerPublication({
  directory,
  version,
  downloadOrigin,
  expectedBuild,
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? ""))
    throw new Error("Source Server publication requires a semantic --version");
  const root = await realpath(resolve(directory));
  const build = validateBuildIdentity(
    JSON.parse(await readArtifact(root, "source-server-build.json")),
    version,
    expectedBuild,
  );
  const source = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readArtifact(root, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)),
  );
  if (
    source.version !== version ||
    source.archives.length !== SOURCE_SERVER_RELEASE_TARGETS.length ||
    SOURCE_SERVER_RELEASE_TARGETS.some(
      (target) => !source.archives.some((archive) => archive.target === target),
    )
  ) {
    throw new Error("Source Server publication requires all four targets at the requested version");
  }
  const releaseRoot = `${RELEASE_PREFIX}/${version}`;
  const objects = new Map();
  const archives = [];
  const releases = [];
  for (const archive of source.archives) {
    const bytes = await readArtifact(root, archive.fileName);
    if (bytes.byteLength !== archive.sizeBytes || hash(bytes) !== archive.sha256) {
      throw new Error(`Source Server archive checksum/size mismatch: ${archive.target}`);
    }
    const { stdout } = await exec(
      "tar",
      ["-xOf", join(root, archive.fileName), `mikiko-server-${archive.target}/manifest.json`],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const manifest = serverRuntimeManifestSchema.parse(JSON.parse(stdout));
    if (manifest.appVersion !== version || manifest.target !== archive.target) {
      throw new Error(
        `Source Server archive manifest metadata/version mismatch: ${archive.target}`,
      );
    }
    const archiveKey = `${releaseRoot}/objects/${archive.sha256}/${archive.fileName}`;
    objects.set(archiveKey, { bytes, contentType: "application/gzip" });
    const components = [];
    if (!manifest.components?.length)
      throw new Error(`Source Server component metadata is missing: ${archive.target}`);
    for (const component of manifest.components) {
      if (!component.archivePath)
        throw new Error(`Source Server component archive is missing: ${component.id}`);
      const componentBytes = await readArtifact(root, component.archivePath);
      const archiveSha256 = hash(componentBytes);
      const key = `${releaseRoot}/objects/${archiveSha256}/${basename(component.archivePath)}`;
      objects.set(key, {
        bytes: componentBytes,
        contentType: "application/gzip",
      });
      components.push({
        id: component.id,
        sha256: component.sha256,
        sizeBytes: component.sizeBytes,
        archiveUrl: objectUrl(downloadOrigin, key),
        archiveSha256,
      });
    }
    const manifestKey = `${releaseRoot}/objects/${archive.sha256}/manifest-${archive.target}.json`;
    objects.set(manifestKey, {
      bytes: jsonBytes(manifest),
      contentType: "application/json",
    });
    const archiveUrl = objectUrl(downloadOrigin, archiveKey);
    archives.push({ ...archive, urls: [archiveUrl] });
    releases.push({
      version,
      appVersion: version,
      target: archive.target,
      archiveUrl,
      archiveSha256: archive.sha256,
      archiveSizeBytes: archive.sizeBytes,
      manifestUrl: objectUrl(downloadOrigin, manifestKey),
      components,
    });
  }
  return {
    build,
    objects,
    descriptorKey: `${releaseRoot}/${SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME}`,
    catalogKey: CATALOG_KEY,
    descriptor: sourceServerReleaseDescriptorSchema.parse({
      ...source,
      archives,
    }),
    catalog: releaseCatalogSchema.parse({ schemaVersion: 1, releases }),
  };
}

export async function publishSourceServerRelease({
  directory,
  version,
  endpoint = "https://agent-update.mikiko.ai",
  downloadOrigin = "https://agent-dl.mikiko.ai",
  token = process.env.UPDATE_PUBLISH_TOKEN,
  expectedBuild,
  verifyOnly = false,
  transportOptions = {},
}) {
  const publication = await prepareSourceServerPublication({
    directory,
    version,
    downloadOrigin,
    expectedBuild,
  });
  if (verifyOnly) return { version, targets: publication.descriptor.archives.length };
  if (!token) throw new Error("UPDATE_PUBLISH_TOKEN is required");
  const { publishBytes, fetchWithRetry } = createUpdatePublishTransport({
    ...transportOptions,
    endpoint,
    token,
  });
  for (const [key, object] of publication.objects) {
    await publishBytes(`/admin/files/${key}`, object.bytes, object.contentType, key);
    const response = await fetchWithRetry(
      objectUrl(downloadOrigin, key),
      { cache: "no-store" },
      "Source Server readback",
    );
    if (!response.ok) throw new Error(`Source Server readback failed: HTTP ${response.status}`);
    const actual = new Uint8Array(await response.arrayBuffer());
    if (actual.byteLength !== object.bytes.byteLength || hash(actual) !== hash(object.bytes)) {
      throw new Error(`Source Server readback checksum mismatch: ${key}`);
    }
  }
  // 所有不可变对象已读回校验；索引最后提交，失败不会让客户端消费半套归档。
  for (const [key, value] of [
    [publication.descriptorKey, publication.descriptor],
    [publication.catalogKey, publication.catalog],
  ]) {
    await publishBytes(`/admin/files/${key}`, jsonBytes(value), "application/json", key);
  }
  return {
    version,
    targets: publication.descriptor.archives.length,
    descriptorKey: publication.descriptorKey,
    catalogKey: publication.catalogKey,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dist: { type: "string" },
      version: { type: "string" },
      endpoint: { type: "string" },
      "download-origin": { type: "string" },
      "source-run-id": { type: "string" },
      commit: { type: "string" },
      tag: { type: "string" },
      "verify-only": { type: "boolean", default: false },
    },
  });
  if (!values.dist) throw new Error("--dist is required");
  const result = await publishSourceServerRelease({
    directory: values.dist,
    version: values.version,
    endpoint: values.endpoint,
    downloadOrigin: values["download-origin"],
    verifyOnly: values["verify-only"],
    expectedBuild: {
      sourceRunId: values["source-run-id"],
      commit: values.commit,
      tag: values.tag,
    },
  });
  console.log(
    `Source Server ${result.version}: ${result.targets} targets ${values["verify-only"] ? "verified" : "published"}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
