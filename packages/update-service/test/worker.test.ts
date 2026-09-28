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
