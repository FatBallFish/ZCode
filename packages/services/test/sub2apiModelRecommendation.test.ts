import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelConfig, ModelConfigRules } from "@zcode/provider";

import { createSub2ApiService } from "../src/sub2api/sub2apiService.js";
import { setDataBaseDir } from "../src/paths.js";

const realFetch = globalThis.fetch;

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: "success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("resolveForRelayModel：modelRules 命中字段优先，未命中降级 modelApiRules，站点规则不参与", () => {
  const rules = new ModelConfigRules([
    {
      // modelApiRules：请求映射与档位（与 API 格式绑定）。
      type: "model-api",
      modelMatch: ".*",
      apiTypeMatch: "anthropic-messages",
      config: ModelConfig.fromData({
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: '{ "thinking": { "type": "enabled" } }',
          },
        },
        properties: { contextWindow: 200000 },
      }),
    },
    {
      // modelRules：模型本体属性（与格式无关）。命中字段必须压过 modelApiRules。
      type: "model",
      modelMatch: ".*gpt-5\\.5.*",
      config: ModelConfig.fromData({
        optionSpecs: { reasoningLevel: { values: ["low", "medium", "high", "xhigh", "max"] } },
        properties: { contextWindow: 400000, inputFormat: { supportsImage: false } },
      }),
    },
    {
      // provider-site：官方端点专属规则（含历史上会被强行复用的 .* 通配能力）。
      type: "provider-site",
      baseUrlMatch: "https://api\\.z\\.ai/api/anthropic/?",
      modelMatch: ".*",
      config: ModelConfig.fromData({
        properties: { inputFormat: { supportsImage: true, supportsVideo: true } },
      }),
    },
  ]);

  // modelRules 命中的模型：values/contextWindow/inputFormat 用 modelRules 值，
  // modelRules 未给的 map 从 modelApiRules 降级保留；站点规则的 image/video 不再混入。
  const resolved = rules
    .resolveForRelayModel({ modelId: "gpt-5.5", apiType: "anthropic-messages" })
    .toJSON();
  assert.deepEqual(resolved.optionSpecs?.reasoningLevel?.values, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(resolved.optionSpecs?.reasoningLevel?.map, '{ "thinking": { "type": "enabled" } }');
  assert.equal(resolved.properties?.contextWindow, 400000);
  assert.equal(resolved.properties?.inputFormat?.supportsImage, false);
  assert.equal(resolved.properties?.inputFormat?.supportsVideo, undefined);

  // modelRules 未命中的模型：全部字段降级走 modelApiRules，同样不吃站点通配。
  const fallback = rules
    .resolveForRelayModel({ modelId: "claude-opus-4", apiType: "anthropic-messages" })
    .toJSON();
  assert.deepEqual(fallback.optionSpecs?.reasoningLevel?.values, ["low", "high"]);
  assert.equal(fallback.properties?.contextWindow, 200000);
  assert.equal(fallback.properties?.inputFormat, undefined);

  // 无 apiType 时带 apiTypeMatch 的 model-api 规则跳过；modelRules 与格式无关仍生效。
  const noApiType = rules.resolveForRelayModel({ modelId: "gpt-5.5" }).toJSON();
  assert.deepEqual(noApiType.optionSpecs?.reasoningLevel?.values, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(noApiType.optionSpecs?.reasoningLevel?.map, undefined);

  // 完全不匹配的模型返回空配置。
  const specificOnly = new ModelConfigRules([
    {
      type: "model",
      modelMatch: "gpt-.*",
      config: ModelConfig.fromData({ properties: { contextWindow: 1 } }),
    },
  ]);
  assert.deepEqual(specificOnly.resolveForRelayModel({ modelId: "claude-x" }).toJSON(), {});
});

test("同步投影：新模型落盘推荐快照，历史空配置模型补写，推荐解析按组合缓存", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sub2api-rec-"));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(base, { recursive: true, force: true });
  });
  setDataBaseDir(base);
  await mkdir(join(base, ".mikiko", "v2"), { recursive: true });
  await writeFile(
    join(base, ".mikiko", "v2", "sub2api.json"),
    JSON.stringify({
      version: 2,
      sites: [
        {
          id: "site-relay",
          kind: "sub2api",
          panelBaseUrl: "https://panel.test",
          gatewayBaseUrl: "https://gw.test",
          siteName: "Relay",
          account: { email: "u@test", balanceUsd: 1, accessToken: "tok" },
          legacyKeys: [
            { id: "k1", name: "K1", apiKey: "sk-x", platform: "openai", status: "active" },
          ],
          providerBindings: [],
        },
      ],
      modelConfigs: {},
    }),
  );

  // 可变推荐返回：第一轮返回空（模拟历史行为），第二轮返回推荐配置。
  let recommendation: Record<string, unknown> = {};
  const resolveCalls: string[] = [];
  const addCalls: Array<{ modelId: string; config: Record<string, unknown> }> = [];
  const draftCalls: Array<{ modelId: string; personalConfig: Record<string, unknown> }> = [];

  const providerSettingsStub = {
    getView: async () => ({
      revision: 1,
      providerTemplates: [],
      providerOrder: [],
      providers: [
        {
          providerId: "p-1",
          enabled: true,
          executable: true,
          effectiveConfig: {},
          issues: [],
          models: modelsSnapshot(),
        },
      ],
    }),
    createPersonalProvider: async () => ({ providerId: "p-1" }),
    savePersonalProviderOverlay: async () => undefined,
    deletePersonalProvider: async () => undefined,
    resolveRelayModelRecommendation: async (input: { modelId: string; apiType?: string }) => {
      resolveCalls.push(`${input.apiType}::${input.modelId}`);
      return { ...recommendation };
    },
    addPersonalModel: async (
      _providerId: string,
      modelId: string,
      config: Record<string, unknown>,
    ) => {
      if (modelsSnapshot().some((model) => model.modelId === modelId)) {
        throw new Error(`Model 已存在: ${modelId}`);
      }
      addedModels.push({
        modelId,
        personalExactConfig: Object.keys(config).length > 0 ? config : undefined,
      });
      addCalls.push({ modelId, config });
    },
    savePersonalModelDraft: async (input: {
      originalModelId: string;
      personalConfig: Record<string, unknown>;
    }) => {
      const model = addedModels.find((entry) => entry.modelId === input.originalModelId);
      if (model) model.personalExactConfig = input.personalConfig;
      draftCalls.push({ modelId: input.originalModelId, personalConfig: input.personalConfig });
    },
  };
  const addedModels: Array<{ modelId: string; personalExactConfig?: Record<string, unknown> }> = [];
  function modelsSnapshot() {
    return addedModels.map((entry) => ({
      modelId: entry.modelId,
      enabled: true,
      executable: true,
      selectable: true,
      issues: [],
      effectiveBuiltinConfig: {},
      effectiveConfig: {},
      ...(entry.personalExactConfig ? { personalExactConfig: entry.personalExactConfig } : {}),
    }));
  }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://gw.test/v1/models")) {
      return envelope([{ id: "glm-5.3" }, { id: "claude-opus-4" }]);
    }
    if (url.startsWith("https://panel.test/api/v1/")) {
      return envelope({ items: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const service = createSub2ApiService({
    providerSettingsService: providerSettingsStub as never,
  });

  // 第一轮：推荐为空（历史行为），模型以空配置落盘。
  await service.syncProviders("site-relay");
  assert.equal(addCalls.length, 2);
  assert.ok(addCalls.every((call) => Object.keys(call.config).length === 0));

  // 第二轮（同一服务实例）：缓存生效——不再重复解析，同组合直接复用空结果，
  // 也不触发补写。
  await service.syncProviders("site-relay");
  assert.equal(resolveCalls.length, 2);
  assert.equal(draftCalls.length, 0);

  // 新会话（新服务实例）：推荐目录可用后，历史空配置模型在同步时补写推荐快照。
  recommendation = { properties: { contextWindow: 123456 } };
  const service2 = createSub2ApiService({
    providerSettingsService: providerSettingsStub as never,
  });
  await service2.syncProviders("site-relay");
  assert.equal(draftCalls.length, 2, "历史空配置模型应补写推荐配置");
  assert.ok(
    draftCalls.every(
      (call) =>
        (call.personalConfig as { properties?: { contextWindow?: number } }).properties
          ?.contextWindow === 123456,
    ),
  );
  // 新实例重新解析（会话级缓存语义），同轮内两模型各解析一次。
  assert.equal(resolveCalls.length, 4);
});
