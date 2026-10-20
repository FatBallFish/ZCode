import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it("shared transport preserves desktop installer, per-architecture feeds and prune ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "mikiko-feed-publish-"));
  const requests: { path: string; body: string; token?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      body: Buffer.concat(chunks).toString(),
      token: request.headers["x-publish-token"] as string | undefined,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keep: 3 }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local fixture port");
    for (const arch of ["arm64", "x64"]) {
      const directory = join(root, `installers-mac-${arch}`);
      await mkdir(directory);
      await writeFile(join(directory, `Mikiko-${arch}.dmg`), `installer-${arch}`);
      await writeFile(
        join(directory, "latest-mac.yml"),
        `version: 1.2.3\nfiles:\n  - url: Mikiko-${arch}.dmg\n`,
      );
    }
    const notes = join(root, "notes.md");
    await writeFile(notes, "Fix regression");
    await exec(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../scripts/publish-update-feed.mjs"),
        "--dist",
        root,
        "--version",
        "1.2.3",
        "--endpoint",
        `http://127.0.0.1:${address.port}`,
        "--download-origin",
        "https://download.example.test",
        "--release-notes",
        notes,
      ],
      {
        env: {
          ...process.env,
          UPDATE_PUBLISH_TOKEN: "fixture-token",
          MIKIKO_RELEASE_PUBLISH_TOKEN: "",
        },
      },
    );
    expect(requests.map((request) => request.path)).toEqual([
      "/admin/files/files/1.2.3/Mikiko-arm64.dmg",
      "/admin/files/files/1.2.3/Mikiko-x64.dmg",
      "/admin/channel/stable/latest-mac-arm64.yml",
      "/admin/channel/stable/latest-mac-x64.yml",
      "/admin/channel/stable/latest-mac.yml",
      "/admin/prune",
    ]);
    expect(requests.every((request) => request.token === "fixture-token")).toBe(true);
    expect(requests[2]?.body).toContain(
      "https://download.example.test/files/1.2.3/Mikiko-arm64.dmg",
    );
    expect(requests[3]?.body).toContain("https://download.example.test/files/1.2.3/Mikiko-x64.dmg");
    expect(requests[4]?.body).toBe(requests[3]?.body);
    expect(requests[2]?.body).toContain("Mikiko 1.2.3 更新日志");
    expect(requests.at(-1)?.body).toBe('{"keep":3}');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
