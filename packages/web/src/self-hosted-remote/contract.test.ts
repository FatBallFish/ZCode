import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import { expect, it } from "vitest";
import { calculateBrowserWebRemoteControlProof } from "./contract.js";
import { readSelfHostedRemoteWorkspace } from "./contract.js";
import { createSelfHostedRemoteUiServices } from "./contract.js";
it("self-hosted browser auth binds proof to nonce, role and device without V2 tokens", async () => {
  const vector = WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS.find(
    (entry) => entry.role === "terminal",
  )!;
  expect(
    await calculateBrowserWebRemoteControlProof(
      vector.passHash,
      vector.nonce,
      vector.role,
      vector.deviceSid,
    ),
  ).toBe(vector.proof);
  expect(
    await calculateBrowserWebRemoteControlProof(
      vector.passHash,
      "other",
      vector.role,
      vector.deviceSid,
    ),
  ).not.toBe(vector.proof);
});

it("自建手机入口从 active 投影恢复工作区，即使持久化 session 已空", () => {
  expect(
    readSelfHostedRemoteWorkspace({
      lastActiveWorkspace: {
        kind: "local",
        workspacePath: "/fixture/current",
        workspacePurpose: "conversation",
      },
      lastActiveTaskByWorkspace: { "/fixture/current": "fixture-task" },
    }),
  ).toEqual({
    initialWorkspaceAbsPath: "/fixture/current",
    initialWorkspacePurpose: "conversation",
    initialTaskId: "fixture-task",
  });
});

it("没有 active 投影时拒绝，不能新建另一个默认工作区掩盖缺失", () => {
  expect(() => readSelfHostedRemoteWorkspace({})).toThrow("No active workspace");
});

it("旧 local 投影缺 purpose/task 时保持缺席，不伪造会话或分类", () => {
  expect(
    readSelfHostedRemoteWorkspace({
      lastActiveWorkspace: { kind: "local", workspacePath: "/fixture/legacy" },
    }),
  ).toEqual({ initialWorkspaceAbsPath: "/fixture/legacy" });
});

it("空路径投影不可挂载 Root", () => {
  expect(() =>
    readSelfHostedRemoteWorkspace({
      lastActiveWorkspace: { kind: "local", workspacePath: " " },
    }),
  ).toThrow("No active workspace");
});

it("手机 UI accessor 明确缺席桌面账号服务，其他服务仍复用同一 attachment", () => {
  const source = {
    sub2ApiService: {
      getSites: () => {
        throw new Error("desktop-only fixture");
      },
    },
    settingService: { get: async () => ({}) },
    zcodeAgentService: {},
  };
  const mobile = createSelfHostedRemoteUiServices(source);
  expect(mobile.sub2ApiService).toBeUndefined();
  expect(mobile.settingService).toBe(source.settingService);
  expect(mobile.zcodeAgentService).toBe(source.zcodeAgentService);
  expect(source.sub2ApiService).toBeDefined();
});

it("remote 身份不能被 local attachment 按相同 cwd 冒领", () => {
  expect(() =>
    readSelfHostedRemoteWorkspace({
      lastActiveWorkspace: {
        kind: "remote",
        workspacePath: "/fixture/same",
        workspaceIdentity: "fixture-remote-identity",
        workspacePurpose: "project",
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
        target: { kind: "ssh", host: "fixture.invalid", username: "fixture" },
      },
    }),
  ).toThrow("Remote workspace requires its Source attachment");
});
