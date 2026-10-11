import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVoiceMicPermission } from "../../src/main/voice/voiceMicPermission.js";

/** askBehavior：ask 的返回值或要抛出的异常；asked 计数不受 override 影响。 */
function makeDeps(
  overrides: Partial<Parameters<typeof createVoiceMicPermission>[0]> = {},
  askBehavior: boolean | Error = true,
) {
  let asked = 0;
  let openedUrl = "";
  const deps = {
    platform: "darwin" as NodeJS.Platform,
    getMediaAccessStatus: () => "granted",
    askForMediaAccessPermission: async () => {
      asked += 1;
      if (askBehavior instanceof Error) throw askBehavior;
      return askBehavior;
    },
    openExternal: async (url: string) => {
      openedUrl = url;
    },
    ...overrides,
  };
  return { deps, asked: () => asked, openedUrl: () => openedUrl };
}

describe("voiceMicPermission", () => {
  it("非 darwin：查询 unsupported、ensure 恒 granted、不打开设置", async () => {
    const { deps } = makeDeps({ platform: "linux" });
    const permission = createVoiceMicPermission(deps);
    assert.equal(permission.getStatus().status, "unsupported");
    assert.equal((await permission.ensure()).status, "granted");
    assert.equal((await permission.openSystemSettings()).ok, false);
  });

  it("darwin not-determined：ensure 弹授权框并按用户选择返回", async () => {
    for (const granted of [true, false]) {
      const { deps, asked } = makeDeps({ getMediaAccessStatus: () => "not-determined" }, granted);
      const permission = createVoiceMicPermission(deps);
      assert.equal((await permission.ensure()).status, granted ? "granted" : "denied");
      assert.equal(asked(), 1);
    }
  });

  it("darwin denied/restricted/granted：ensure 不再弹授权框", async () => {
    for (const status of ["denied", "restricted", "granted"] as const) {
      const { deps, asked } = makeDeps({ getMediaAccessStatus: () => status });
      const permission = createVoiceMicPermission(deps);
      assert.equal((await permission.ensure()).status, status);
      assert.equal(asked(), 0);
    }
  });

  it("未知原始状态按 denied 保守处理", () => {
    const { deps } = makeDeps({ getMediaAccessStatus: () => "weird-future-value" });
    assert.equal(createVoiceMicPermission(deps).getStatus().status, "denied");
  });

  it("ask 抛异常按 denied 处理（不打崩调用链）", async () => {
    const { deps } = makeDeps({ getMediaAccessStatus: () => "not-determined" }, new Error("boom"));
    assert.equal((await createVoiceMicPermission(deps).ensure()).status, "denied");
  });

  it("openSystemSettings 打开 macOS 隐私面板深链；openExternal 失败返回 ok:false", async () => {
    const ok = makeDeps();
    assert.equal((await createVoiceMicPermission(ok.deps).openSystemSettings()).ok, true);
    assert.match(ok.openedUrl(), /^x-apple\.systempreferences:.*Privacy_Microphone/);
    const bad = makeDeps({
      openExternal: async () => {
        throw new Error("nope");
      },
    });
    assert.equal((await createVoiceMicPermission(bad.deps).openSystemSettings()).ok, false);
  });
});
