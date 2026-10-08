import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/worker.ts";

/** per-arch manifest 路由（2026-09-29 应用内更新适配 arm64）：优先架构键，回退历史共用键。 */
function createEnv(channels: Record<string, string>) {
  return {
    RELEASES: {
      async get(key: string) {
        const body = channels[key];
        return body === undefined ? null : { body, text: async () => body, size: body.length };
      },
      async put() {},
    },
    UPDATE_CONFIG: {
      async get() {
        return null;
      },
    },
    PUBLISH_TOKEN: "tok",
  };
}

function call(env: ReturnType<typeof createEnv>, query: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://agent-update.mikiko.ai/api/v1/releases/electron/manifest?${query}`),
    env,
  ) as Promise<Response>;
}

const X64 =
  "version: 1.0.7\nfiles:\n  - url: https://agent-dl.mikiko.ai/files/1.0.7/Mikiko-1.0.7-mac-x64.zip\n";
const ARM =
  "version: 1.0.7\nfiles:\n  - url: https://agent-dl.mikiko.ai/files/1.0.7/Mikiko-1.0.7-mac-arm64.zip\n";
const LEGACY =
  "version: 1.0.6\nfiles:\n  - url: https://agent-dl.mikiko.ai/files/1.0.6/Mikiko-1.0.6-mac-x64.zip\n";

describe("per-arch manifest 路由", () => {
  it("darwin-arm64 优先 arm 清单；darwin-x64 优先 x64 清单", async () => {
    const env = createEnv({
      "channels/stable/latest-mac-arm64.yml": ARM,
      "channels/stable/latest-mac-x64.yml": X64,
    });
    const arm = await call(env, "platform=darwin-arm64&channel=1");
    assert.equal(arm.status, 200);
    assert.match(await arm.text(), /mac-arm64\.zip/u);
    const x64 = await call(env, "platform=darwin-x86_64&channel=1");
    assert.match(await x64.text(), /mac-x64\.zip/u);
  });

  it("架构键缺失时回退历史共用键（存量版本更新路径不断）", async () => {
    const env = createEnv({ "channels/stable/latest-mac.yml": LEGACY });
    const arm = await call(env, "platform=darwin-arm64&channel=1");
    assert.equal(arm.status, 200);
    assert.match(await arm.text(), /1\.0\.6/u);
    const x64 = await call(env, "platform=darwin-x86_64&channel=1");
    assert.equal(x64.status, 200);
  });

  it("windows-arm64 支持：优先 latest-arm64，回退 latest.yml", async () => {
    const only = createEnv({ "channels/stable/latest.yml": "version: 1.0.7\n" });
    const fallback = await call(only, "platform=windows-arm64&channel=1");
    assert.equal(fallback.status, 200);
    const both = createEnv({
      "channels/stable/latest-arm64.yml": "version: 1.0.7-arm\n",
      "channels/stable/latest.yml": "version: 1.0.7-x64\n",
    });
    const arm = await call(both, "platform=windows-arm64&channel=1");
    assert.match(await arm.text(), /1\.0\.7-arm/u);
    const x64 = await call(both, "platform=windows-x86_64&channel=1");
    assert.match(await x64.text(), /1\.0\.7-x64/u);
  });

  it("全部键缺失返回 404 no_release；未知 platform 400", async () => {
    const env = createEnv({});
    const missing = await call(env, "platform=darwin-arm64&channel=1");
    assert.equal(missing.status, 404);
    const unknown = await call(env, "platform=freebsd-x86_64&channel=1");
    assert.equal(unknown.status, 400);
  });

  it("darwin-aarch64 旧取值同样路由 arm 清单", async () => {
    const env = createEnv({ "channels/stable/latest-mac-arm64.yml": ARM });
    const response = await call(env, "platform=darwin-aarch64&channel=1");
    assert.match(await response.text(), /mac-arm64\.zip/u);
  });
});

/** prune 用：可 list/delete 的 R2 内存 mock（files/<version>/<asset> → 字节数）。 */
function createStorageEnv(sizes: Record<string, number>) {
  const store = new Map(Object.entries(sizes).map(([key, size]) => [key, { key, size }]));
  const env = {
    RELEASES: {
      async get(key: string) {
        const object = store.get(key);
        return object ?? null;
      },
      async put() {},
      async list(options: { prefix?: string }) {
        return {
          objects: [...store.values()].filter((object) =>
            object.key.startsWith(options.prefix ?? ""),
          ),
          truncated: false,
        };
      },
      async delete(keys: string[]) {
        for (const key of keys) {
          store.delete(key);
        }
      },
    },
    UPDATE_CONFIG: {
      async get() {
        return null;
      },
    },
    PUBLISH_TOKEN: "tok",
  };
  return { env, remainingKeys: () => [...store.keys()].sort() };
}

describe("/admin/prune 旧版本清理（R2 配额）", () => {
  it("按语义版本保留最新 keep 版，更旧版本整目录删除；channels/ 不参与", async () => {
    const { env, remainingKeys } = createStorageEnv({
      "files/1.0.7/Mikiko.dmg": 100,
      "files/1.0.7/Mikiko.blockmap": 10,
      "files/1.0.10/Mikiko.dmg": 200,
      "files/1.0.6/Mikiko.dmg": 100,
      "channels/stable/latest.yml": 1,
    });
    const response = await worker.fetch(
      new Request("https://agent-update.mikiko.ai/admin/prune", {
        method: "POST",
        headers: { "x-publish-token": "tok", "content-type": "application/json" },
        body: JSON.stringify({ keep: 2 }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      keep: number;
      keptVersions: string[];
      prunedVersions: string[];
      deletedCount: number;
      freedBytes: number;
    };
    // 语义版本排序：1.0.10 > 1.0.7 > 1.0.6（字符串排序会把 1.0.10 排在 1.0.7 前）。
    assert.deepEqual(body.keptVersions, ["1.0.10", "1.0.7"]);
    assert.deepEqual(body.prunedVersions, ["1.0.6"]);
    assert.equal(body.deletedCount, 1);
    assert.equal(body.freedBytes, 100);
    assert.deepEqual(remainingKeys(), [
      "channels/stable/latest.yml",
      "files/1.0.10/Mikiko.dmg",
      "files/1.0.7/Mikiko.blockmap",
      "files/1.0.7/Mikiko.dmg",
    ]);
  });

  it("无 token 401；keep 边界收敛（0→1、99→10）", async () => {
    const { env } = createStorageEnv({ "files/1.0.7/Mikiko.dmg": 1 });
    const unauthorized = await worker.fetch(
      new Request("https://agent-update.mikiko.ai/admin/prune", {
        method: "POST",
        body: JSON.stringify({ keep: 1 }),
      }),
      env,
    );
    assert.equal(unauthorized.status, 401);

    for (const [requested, expected] of [
      [0, 1],
      [99, 10],
      [NaN, 3],
    ] as const) {
      const response = await worker.fetch(
        new Request("https://agent-update.mikiko.ai/admin/prune", {
          method: "POST",
          headers: { "x-publish-token": "tok", "content-type": "application/json" },
          body: JSON.stringify({ keep: requested }),
        }),
        env,
      );
      assert.equal(((await response.json()) as { keep: number }).keep, expected);
    }
  });
});
