import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { getPlatformProxy, unstable_dev } from "wrangler";

describe(
  "download ranges against the real local Worker and R2 binding",
  { concurrency: false },
  () => {
    let directory: string;
    let server: Awaited<ReturnType<typeof unstable_dev>> | undefined;
    const key = "files/1.1.4/mikiko-range-fixture.bin";
    const emptyKey = "files/1.1.4/empty-fixture.bin";
    const bytes = Uint8Array.from({ length: 128 }, (_, index) => index);

    before(
      async () => {
        directory = await mkdtemp(join(tmpdir(), "mikiko-update-range-"));
        const configPath = join(directory, "wrangler.json");
        const persistence = join(directory, "r2-state");
        const script = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
        await writeFile(
          configPath,
          JSON.stringify({
            name: "mikiko-update-range-test",
            main: script,
            compatibility_date: "2025-09-01",
            send_metrics: false,
            r2_buckets: [{ binding: "RELEASES", bucket_name: "mikiko-range-test", remote: false }],
          }),
        );
        const platform = await getPlatformProxy<{
          RELEASES: { put(key: string, body: Uint8Array): Promise<unknown> };
        }>({
          configPath,
          envFiles: [],
          persist: { path: join(persistence, "v3") },
          remoteBindings: false,
        });
        try {
          await platform.env.RELEASES.put(key, bytes);
          await platform.env.RELEASES.put(emptyKey, new Uint8Array());
        } finally {
          await platform.dispose();
        }
        server = await unstable_dev(script, {
          config: configPath,
          envFiles: [],
          local: true,
          ip: "127.0.0.1",
          port: 0,
          inspectorPort: 0,
          inspect: false,
          persist: true,
          persistTo: persistence,
          logLevel: "error",
          experimental: {
            forceLocal: true,
            disableExperimentalWarning: true,
            disableDevRegistry: true,
            fileBasedRegistry: false,
            watch: false,
            showInteractiveDevSession: false,
            enableContainers: false,
          },
        });
      },
      { timeout: 60_000 },
    );

    after(async () => {
      try {
        await server?.stop();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });

    const download = (range?: string, method = "GET", objectKey = key) => {
      assert.ok(server);
      return server.fetch(`https://agent-dl.example/${objectKey}`, {
        method,
        headers: { host: "agent-dl.example", ...(range ? { range } : {}) },
      });
    };

    for (const [range, offset, length] of [
      ["bytes=0-31", 0, 32],
      ["bytes=17-32", 17, 16],
      ["bytes=120-999", 120, 8],
      ["bytes=120-", 120, 8],
      ["bytes=-8", 120, 8],
      ["bytes=-999", 0, 128],
    ] as const) {
      it(`${range} reports exactly the bytes R2 streams`, async () => {
        const response = await download(range);
        assert.equal(response.status, 206);
        assert.equal(
          response.headers.get("content-range"),
          `bytes ${offset}-${offset + length - 1}/128`,
        );
        assert.equal(response.headers.get("content-length"), String(length));
        assert.equal(response.headers.get("accept-ranges"), "bytes");
        assert.match(response.headers.get("cache-control") ?? "", /immutable/);
        assert.ok(response.headers.get("etag"));
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          bytes.slice(offset, offset + length),
        );
      });
    }

    for (const range of ["bytes=128-", "bytes=999-1000", "bytes=12-4", "bytes=-0"]) {
      it(`${range} returns 416 with the complete size and an empty body`, async () => {
        const response = await download(range);
        assert.equal(response.status, 416);
        assert.equal(response.headers.get("content-range"), "bytes */128");
        assert.equal(response.headers.get("content-length"), "0");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal((await response.arrayBuffer()).byteLength, 0);
      });
    }

    it("any byte range on an empty object is unsatisfiable", async () => {
      const response = await download("bytes=0-0", "GET", emptyKey);
      assert.equal(response.status, 416);
      assert.equal(response.headers.get("content-range"), "bytes */0");
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    });

    for (const range of [
      undefined,
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=invalid",
      "bytes=9007199254740992-",
    ]) {
      it(`keeps full-response behavior for unsupported range ${range ?? "(absent)"}`, async () => {
        const response = await download(range);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-range"), null);
        assert.equal(response.headers.get("content-length"), "128");
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      });
    }

    it("HEAD ignores Range and returns full metadata without a body", async () => {
      const response = await download("bytes=0-31", "HEAD");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-range"), null);
      assert.equal(response.headers.get("content-length"), "128");
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    });

    it("keeps missing-object and unsupported-method behavior", async () => {
      assert.equal((await download("bytes=0-31", "GET", "files/missing.bin")).status, 404);
      assert.equal((await download(undefined, "POST")).status, 405);
    });
  },
);
