import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import worker from "../src/worker.ts";
import { resetLatestReleaseCacheForTest } from "../src/releases.ts";
import { createMemoryKv, createMemoryR2 } from "./helpers.ts";

/** manifest YAML 样例（与 electron-updater latest*.yml 形状一致，含中文 releaseNotes）。 */
function manifestYaml(version: string, fileUrl: string, notes: string): string {
  return `version: ${version}
files:
  - url: ${fileUrl}
    sha512: abc=
    size: 185175089
path: file.zip
sha512: abc=
releaseDate: '2026-09-25T04:32:43.547Z'
releaseNotesByLocale:
  zh-CN:
    title: "Mikiko ${version} 更新日志"
    markdown: |
      ## BugFix

      - ${notes}

      ## 安装说明

      \`\`\`bash
      xattr -rc /Applications/Mikiko.app
      \`\`\`
  en-US:
    title: "Mikiko ${version}"
    markdown: |
      en body
`;
}

const realFetch = globalThis.fetch;
const requestedUrls: string[] = [];

function mockManifestFetch() {
  requestedUrls.length = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    requestedUrls.push(url.pathname + url.search);
    if (url.pathname !== "/api/v1/releases/electron/manifest") {
      return new Response("not found", { status: 404 });
    }
    const platform = url.searchParams.get("platform");
    if (platform === "darwin-aarch64") {
      return new Response(
        manifestYaml(
          "1.0.5",
          "https://agent-dl.mikiko.ai/files/1.0.5/Mikiko-1.0.5-mac-x64.dmg",
          "mac 修复",
        ),
      );
    }
    if (platform === "windows-x86_64") {
      return new Response(
        manifestYaml(
          "1.0.5",
          "https://agent-dl.mikiko.ai/files/1.0.5/Mikiko-1.0.5-win-x64.exe",
          "win 修复",
        ),
      );
    }
    if (platform === "linux-x86_64") {
      return new Response(
        `version: 1.0.5
files:
  - url: https://agent-dl.mikiko.ai/files/1.0.5/Mikiko-1.0.5-linux-x86_64.AppImage
    size: 120000000
  - url: https://agent-dl.mikiko.ai/files/1.0.5/Mikiko-1.0.5-linux-amd64.deb
    size: 118000000
releaseDate: '2026-09-25T04:32:43.547Z'
releaseNotesByLocale:
  zh-CN:
    markdown: |
      linux notes
`,
      );
    }
    return new Response("bad platform", { status: 400 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function createEnv() {
  return {
    ASSETS: {
      async fetch() {
        return new Response("Not Found", { status: 404 });
      },
    } as unknown as Fetcher,
    MIKIKO_BUILTIN_CONFIG: createMemoryKv(),
    MIKIKO_CLIENT_CONFIG: createMemoryKv(),
    MIKIKO_SHARE: createMemoryKv(),
    SHARE_ARTIFACTS: createMemoryR2(),
    MIKIKO_ADMIN_USERNAME: "a",
    MIKIKO_ADMIN_PASSWORD: "b",
    MIKIKO_ADMIN_SESSION_SECRET: "c",
    MIKIKO_RELEASE_PUBLISH_TOKEN: "release-token",
  };
}

function call(
  env: ReturnType<typeof createEnv>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://agent.mikiko.ai${path}`, init),
    env,
  ) as Promise<Response>;
}

describe("GET /api/v1/releases/latest（manifest 聚合）", () => {
  it("三平台聚合：版本、直链分类、中文更新日志", async () => {
    mockManifestFetch();
    const response = await call(createEnv(), "/api/v1/releases/latest");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      version: string;
      releaseDate: string | null;
      releaseNotesZhCn: string;
      files: Array<{ kind: string; url: string; sizeBytes: number }>;
    };
    assert.equal(body.version, "1.0.5");
    assert.match(body.releaseDate ?? "", /^2026-09-25/u);
    assert.match(body.releaseNotesZhCn, /## BugFix/u);
    assert.match(body.releaseNotesZhCn, /mac 修复/u);
    assert.match(body.releaseNotesZhCn, /xattr -rc \/Applications\/Mikiko\.app/u);
    const kinds = body.files.map((file) => file.kind).sort();
    assert.deepEqual(kinds, ["appimage", "deb", "macos-dmg", "windows-exe"]);
    const dmg = body.files.find((file) => file.kind === "macos-dmg");
    assert.match(dmg?.url ?? "", /Mikiko-1\.0\.5-mac-x64\.dmg$/u);
    assert.equal(dmg?.sizeBytes, 185175089);
    // 三平台 manifest 都被拉取。
    assert.equal(requestedUrls.length, 3);
  });

  it("上游不可用返回 503（无缓存时）", async () => {
    resetLatestReleaseCacheForTest();
    globalThis.fetch = (async () => new Response("down", { status: 502 })) as typeof fetch;
    const response = await call(createEnv(), "/api/v1/releases/latest");
    assert.equal(response.status, 503);
  });
});

describe("更新日志历史（KV + 发布流水线写入）", () => {
  it("PUT 需要正确令牌；写入后 notes 按版本倒序返回", async () => {
    const env = createEnv();
    const unauthorized = await call(env, "/api/v1/admin/release-notes", {
      method: "PUT",
      headers: { "x-publish-token": "wrong", "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.6", markdown: "## X" }),
    });
    assert.equal(unauthorized.status, 401);

    for (const [version, markdown] of [
      ["1.0.4", "## 1.0.4"],
      ["1.0.6", "## 1.0.6"],
    ] as const) {
      const put = await call(env, "/api/v1/admin/release-notes", {
        method: "PUT",
        headers: { "x-publish-token": "release-token", "content-type": "application/json" },
        body: JSON.stringify({ version, markdown }),
      });
      assert.equal(put.status, 200);
    }
    // 非法 payload 拒绝。
    const invalid = await call(env, "/api/v1/admin/release-notes", {
      method: "PUT",
      headers: { "x-publish-token": "release-token", "content-type": "application/json" },
      body: JSON.stringify({ version: "abc", markdown: "x" }),
    });
    assert.equal(invalid.status, 400);

    const notes = await call(env, "/api/v1/releases/notes");
    assert.equal(notes.status, 200);
    const body = (await notes.json()) as { entries: Array<{ version: string }> };
    assert.deepEqual(
      body.entries.map((entry) => entry.version),
      ["1.0.6", "1.0.4"],
    );
  });

  it("同版本重复 PUT 幂等覆盖（流水线重跑不产生重复条目）", async () => {
    const env = createEnv();
    for (let index = 0; index < 2; index += 1) {
      const put = await call(env, "/api/v1/admin/release-notes", {
        method: "PUT",
        headers: { "x-publish-token": "release-token", "content-type": "application/json" },
        body: JSON.stringify({ version: "1.0.6", markdown: `## 第 ${index} 次` }),
      });
      assert.equal(put.status, 200);
    }
    const body = (await (await call(env, "/api/v1/releases/notes")).json()) as {
      entries: Array<{ version: string; markdown: string }>;
    };
    assert.equal(body.entries.length, 1);
    assert.match(body.entries[0]!.markdown, /第 1 次/u);
  });
});
