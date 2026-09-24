import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

import {
  resolveBuiltinCodingPlanProviderId,
  resolveModelProviderTargetSelection,
} from "../src/settings/model-provider-section/providerTargetResolution.js";

const EMPTY_CONTEXT = {
  customProviderIds: new Set<string>(),
  relayProviderSiteIdByKey: new Map<string, string>(),
  relaySiteIds: new Set<string>(),
  navigationReady: true,
};

test("内置 Coding Plan / Start Plan ID 解析到家族侧节点", () => {
  const individual = resolveModelProviderTargetSelection(
    { providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan },
    EMPTY_CONTEXT,
  );
  assert.equal(individual.kind, "node");
  assert.match((individual as { nodeKey: string }).nodeKey, /^preset:/);

  const start = resolveModelProviderTargetSelection(
    { providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan },
    EMPTY_CONTEXT,
  );
  assert.equal(start.kind, "node");
  assert.match((start as { nodeKey: string }).nodeKey, /^coding-plan:/);

  assert.equal(
    resolveBuiltinCodingPlanProviderId(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan),
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  assert.equal(resolveBuiltinCodingPlanProviderId("personal-abc"), null);
});

test("中转站密钥供应商解析到对应站点节点（跟随当前会话供应商）", () => {
  const context = {
    customProviderIds: new Set<string>(),
    relayProviderSiteIdByKey: new Map([["personal-relay-1", "site-eagle"]]),
    relaySiteIds: new Set(["site-eagle"]),
    navigationReady: true,
  };
  const resolution = resolveModelProviderTargetSelection(
    { providerId: "personal-relay-1" },
    context,
  );
  assert.deepEqual(resolution, { kind: "node", nodeKey: "relay:site-eagle" });
});

test("普通自定义供应商解析到自定义分组节点", () => {
  const resolution = resolveModelProviderTargetSelection(
    { providerId: "personal-custom-9" },
    {
      customProviderIds: new Set(["personal-custom-9"]),
      relayProviderSiteIdByKey: new Map<string, string>(),
      relaySiteIds: new Set<string>(),
      navigationReady: true,
    },
  );
  assert.deepEqual(resolution, { kind: "node", nodeKey: "custom:personal-custom-9" });
});

test("数据未就绪时非内置 ID 保持 pending，就绪后仍找不到才判 invalid", () => {
  const context = {
    customProviderIds: new Set<string>(),
    relayProviderSiteIdByKey: new Map<string, string>(),
    relaySiteIds: new Set<string>(),
    navigationReady: false,
  };
  assert.deepEqual(
    resolveModelProviderTargetSelection({ providerId: "personal-unknown" }, context),
    { kind: "pending" },
  );
  assert.deepEqual(
    resolveModelProviderTargetSelection({ providerId: "personal-unknown" }, EMPTY_CONTEXT),
    { kind: "invalid" },
  );
  // 空目标与空白 ID 直接 invalid（无需等数据）。
  assert.deepEqual(resolveModelProviderTargetSelection(undefined, context), { kind: "invalid" });
  assert.deepEqual(resolveModelProviderTargetSelection({ providerId: "  " }, context), {
    kind: "invalid",
  });
});

test("站点目标（footer 展示中转站账号）直接定位对应站点节点", () => {
  const context = {
    customProviderIds: new Set<string>(),
    relayProviderSiteIdByKey: new Map<string, string>(),
    relaySiteIds: new Set(["site-mikikocc", "site-eagle"]),
    navigationReady: true,
  };
  assert.deepEqual(resolveModelProviderTargetSelection({ relaySiteId: "site-eagle" }, context), {
    kind: "node",
    nodeKey: "relay:site-eagle",
  });
  // 站点 id 已知即可命中（就绪标志只约束供应商列表相关的判定）；
  // 站点列表为空且未就绪时保持 pending，就绪后仍未知才判 invalid。
  assert.deepEqual(
    resolveModelProviderTargetSelection(
      { relaySiteId: "site-eagle" },
      { ...context, customProviderIds: new Set<string>(), navigationReady: false },
    ),
    { kind: "node", nodeKey: "relay:site-eagle" },
  );
  assert.deepEqual(
    resolveModelProviderTargetSelection(
      { relaySiteId: "site-eagle" },
      { ...EMPTY_CONTEXT, navigationReady: false },
    ),
    { kind: "pending" },
  );
  assert.deepEqual(
    resolveModelProviderTargetSelection({ relaySiteId: "site-eagle" }, EMPTY_CONTEXT),
    { kind: "invalid" },
  );
  assert.deepEqual(resolveModelProviderTargetSelection({ relaySiteId: "site-gone" }, context), {
    kind: "invalid",
  });
});

test("回归：非内置供应商不得因数据未加载被误判 invalid（智谱回退根因）", () => {
  // 修复前：任何非 6 个内置 Coding Plan 的 providerId 都被判 invalid，
  // 导航回退到智谱 Coding Plan 侧——「设置页自动切到智谱账户」。
  const context = {
    customProviderIds: new Set<string>(),
    relayProviderSiteIdByKey: new Map<string, string>(),
    relaySiteIds: new Set<string>(),
    navigationReady: false,
  };
  const resolution = resolveModelProviderTargetSelection(
    { providerId: "personal-relay-1" },
    context,
  );
  assert.notEqual(resolution.kind, "invalid");
});
