import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectSourceServerRemoteReleaseArchives } from "../src/packaging/remoteAssetRelease.js";
import { createRuntimeManifest } from "../src/runtime/manifest.js";
import { releaseCatalogSchema } from "../src/contracts.js";
import {
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
} from "@zcode/shared/source-server/release";

const exec = promisify(execFile);
const version = "1.2.3";
const token = "local-publish-token";
const build = {
  schemaVersion: 1,
  version,
  sourceRunId: "100",
  commit: "a".repeat(40),
  tag: "v1.2.3",
};
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(wrongVersion = false) {
  const root = await mkdtemp(join(tmpdir(), "mikiko-source-publish-"));
  roots.push(root);
  const dist = join(root, "dist");
  const directory = join(root, "artifact");
  await mkdir(dist);
  for (const target of SOURCE_SERVER_RELEASE_TARGETS) {
    const name = `mikiko-server-${target}`;
    const stage = join(dist, name);
    await mkdir(join(stage, "runtime"), { recursive: true });
    await writeFile(join(stage, "runtime/node"), randomBytes(2048));
    const archivePath = `components/${target}/node-runtime-${"b".repeat(64)}.tar.gz`;
    await mkdir(join(dist, "components", target), { recursive: true });
    await exec("tar", ["-czf", join(dist, archivePath), "runtime/node"], {
      cwd: stage,
    });
    const manifest = createRuntimeManifest(target, wrongVersion ? "0.0.1" : version, {
      components: [
        {
          id: "node-runtime",
          sha256: "b".repeat(64),
          paths: ["runtime/node"],
          sizeBytes: 2048,
          archivePath,
        },
      ],
    });
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest));
    await exec("tar", ["-czf", join(dist, `${name}.tar.gz`), name], {
      cwd: dist,
    });
  }
  await collectSourceServerRemoteReleaseArchives({
    distReleaseDir: dist,
    versionReleaseDir: directory,
    version,
  });
  await cp(join(dist, "components"), join(directory, "components"), {
    recursive: true,
  });
  await writeFile(join(directory, "source-server-build.json"), JSON.stringify(build));
  return directory;
}

async function httpStore(
  options: {
    rejectWrites?: boolean;
    corruptReads?: boolean;
    failOnePart?: boolean;
  } = {},
) {
  const objects = new Map<string, Buffer>();
  const events: Array<{ operation: string; key: string }> = [];
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  let failed = false;
  let rejectedWrites = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://local");
    const body = Buffer.concat(await Array.fromAsync(request));
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/admin/") && request.headers["x-publish-token"] !== token)
      return json({ error: "unauthorized" }, 401);
    if (request.method === "GET") {
      const key = url.pathname.slice(1);
      events.push({ operation: "read", key });
      const bytes = objects.get(key);
      response.writeHead(bytes ? 200 : 404);
      return response.end(options.corruptReads && bytes ? "corrupt" : bytes);
    }
    if (options.rejectWrites) {
      rejectedWrites += 1;
      return json({ error: "denied" }, 403);
    }
    const store = (key: string, bytes: Buffer) => {
      objects.set(key, bytes);
      events.push({ operation: "write", key });
    };
    if (url.pathname.startsWith("/admin/files/")) {
      const key = url.pathname.slice("/admin/files/".length);
      store(key, body);
      return json({ ok: true, key });
    }
    if (url.pathname === "/admin/multipart/init") {
      const { key } = JSON.parse(body.toString());
      const uploadId = String(uploads.size + 1);
      uploads.set(uploadId, { key, parts: new Map() });
      return json({ uploadId });
    }
    const part = /^\/admin\/multipart\/(\d+)\/(\d+)$/u.exec(url.pathname);
    if (part) {
      if (options.failOnePart && !failed) {
        failed = true;
        return json({ error: "retry" }, 503);
      }
      uploads.get(part[1]!)!.parts.set(Number(part[2]), body);
      events.push({ operation: "part", key: url.searchParams.get("key")! });
      return json({ etag: hash(body), partNumber: Number(part[2]) });
    }
    if (url.pathname === "/admin/multipart/complete") {
      const { uploadId, key, parts } = JSON.parse(body.toString());
      const upload = uploads.get(uploadId)!;
      store(
        key,
        Buffer.concat(
          parts.map((item: { partNumber: number }) => upload.parts.get(item.partNumber)!),
        ),
      );
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not start");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    objects,
    events,
    rejectedWrites: () => rejectedWrites,
  };
}

async function publish(
  directory: string,
  store: Awaited<ReturnType<typeof httpStore>>,
  extra = {},
) {
  const { publishSourceServerRelease } =
    await import("../../../scripts/publish-source-server-release.mjs");
  return publishSourceServerRelease({
    directory,
    version,
    endpoint: store.origin,
    downloadOrigin: store.origin,
    token,
    expectedBuild: build,
    ...extra,
  });
}

describe("Source Server 自建发行发布", () => {
  it("从同一四平台归档生成两个严格索引，读回验证后才发布索引", async () => {
    const directory = await fixture();
    const store = await httpStore();
    await publish(directory, store);
    const descriptorKey = `mikiko/electron/releases/${version}/source-server-release.json`;
    const catalogKey = "mikiko/server/catalog.json";
    expect(
      store.events
        .filter((event) => event.operation === "write")
        .slice(-2)
        .map((event) => event.key),
    ).toEqual([descriptorKey, catalogKey]);
    const descriptor = sourceServerReleaseDescriptorSchema.parse(
      JSON.parse(store.objects.get(descriptorKey)!.toString()),
    );
    const catalog = releaseCatalogSchema.parse(
      JSON.parse(store.objects.get(catalogKey)!.toString()),
    );
    expect(catalog.releases).toHaveLength(4);
    for (const archive of descriptor.archives) {
      const release = catalog.releases.find((entry) => entry.target === archive.target)!;
      expect(release.version).toBe(version);
      expect(release.archiveUrl).toBe(archive.urls[0]);
      expect(release.archiveSha256).toBe(archive.sha256);
      expect(release.components).toHaveLength(1);
      expect(release.manifestUrl).toContain(`/objects/${archive.sha256}/`);
      const bytes = store.objects.get(new URL(release.archiveUrl).pathname.slice(1))!;
      expect(hash(bytes)).toBe(archive.sha256);
    }
  });

  it("完整本机HTTP分片和503重试仍收敛到同一对象字节", async () => {
    const directory = await fixture();
    const store = await httpStore({ failOnePart: true });
    await publish(directory, store, {
      transportOptions: {
        multipartThreshold: 1024,
        partSize: 512,
        retryDelayMs: 0,
      },
    });
    expect(store.events.some((event) => event.operation === "part")).toBe(true);
    expect(store.objects.has("mikiko/server/catalog.json")).toBe(true);
  });

  it("混用原构建run或commit时零上传", async () => {
    const directory = await fixture();
    const store = await httpStore();
    await expect(
      publish(directory, store, {
        expectedBuild: { ...build, sourceRunId: "999" },
      }),
    ).rejects.toThrow(/build identity/u);
    expect(store.events).toEqual([]);
  });

  it("归档字节被改动时零上传", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "mikiko-server-linux-x64.tar.gz"), "changed");
    const store = await httpStore();
    await expect(publish(directory, store)).rejects.toThrow(/checksum|size/iu);
    expect(store.events).toEqual([]);
  });

  it("缺target或归档内版本不一致时零上传", async () => {
    const directory = await fixture(true);
    const store = await httpStore();
    await expect(publish(directory, store)).rejects.toThrow(/manifest.*version|metadata/iu);
    expect(store.events).toEqual([]);
    const descriptorPath = join(directory, "source-server-release.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.archives.pop();
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    await expect(publish(directory, store)).rejects.toThrow(/four|target/iu);
  });

  it("确定性403不重试，也不推进索引", async () => {
    const store = await httpStore({ rejectWrites: true });
    await expect(publish(await fixture(), store)).rejects.toThrow(/403/u);
    expect(store.rejectedWrites()).toBe(1);
    expect(store.objects.size).toBe(0);
  });

  it("下载域读回不一致时不发布两个索引", async () => {
    const store = await httpStore({ corruptReads: true });
    await expect(publish(await fixture(), store)).rejects.toThrow(/readback|checksum/iu);
    expect(
      [...store.objects.keys()].some(
        (key) => key.endsWith("catalog.json") || key.endsWith("source-server-release.json"),
      ),
    ).toBe(false);
  });
});
