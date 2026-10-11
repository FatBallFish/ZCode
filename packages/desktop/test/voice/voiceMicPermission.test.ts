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
    askForMediaAccess: async () => {
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

  it("darwin「去开启」：not-determined 先补请求，允许则不再跳设置页", async () => {
    const allowed = makeDeps({ getMediaAccessStatus: () => "not-determined" }, true);
    const allowedResult = await createVoiceMicPermission(allowed.deps).openSystemSettings();
    assert.equal(allowedResult.ok, true);
    assert.equal(allowedResult.status, "granted");
    assert.equal(allowed.asked(), 1);
    assert.equal(allowed.openedUrl(), "");
  });

  it("darwin「去开启」：补请求被拒后跳隐私面板（应用已写入列表）", async () => {
    const denied = makeDeps({ getMediaAccessStatus: () => "not-determined" }, false);
    const result = await createVoiceMicPermission(denied.deps).openSystemSettings();
    assert.equal(result.ok, true);
    assert.equal(result.status, "denied");
    assert.equal(denied.asked(), 1);
    assert.match(denied.openedUrl(), /^x-apple\.systempreferences:.*Privacy_Microphone/);
  });

  it("darwin「去开启」：已 denied（记录存在）不重复弹框直接跳面板", async () => {
    const { deps, asked, openedUrl } = makeDeps({ getMediaAccessStatus: () => "denied" });
    const result = await createVoiceMicPermission(deps).openSystemSettings();
    assert.equal(result.ok, true);
    assert.equal(asked(), 0);
    assert.match(openedUrl(), /^x-apple\.systempreferences:.*Privacy_Microphone/);
  });

  it("win32「去开启」：跳 ms-settings 麦克风隐私页", async () => {
    const { deps, openedUrl } = makeDeps({ platform: "win32" });
    const result = await createVoiceMicPermission(deps).openSystemSettings();
    assert.equal(result.ok, true);
    assert.equal(openedUrl(), "ms-settings:privacy-microphone");
  });

  it("openExternal 失败返回 ok:false（不打崩调用链）", async () => {
    // denied 状态才会走到 openExternal（granted 在补请求环节即短路返回）。
    const bad = makeDeps({
      getMediaAccessStatus: () => "denied",
      openExternal: async () => {
        throw new Error("nope");
      },
    });
    const result = await createVoiceMicPermission(bad.deps).openSystemSettings();
    assert.equal(result.ok, false);
    assert.equal(result.status, "denied");
  });
});
