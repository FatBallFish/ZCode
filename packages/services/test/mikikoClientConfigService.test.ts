import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ApiClient } from "@zcode/shared";
import { createMikikoClientConfigService } from "../src/model-provider/mikikoClientConfigService.js";

const URL_ENV_KEY = "MIKIKO_CLIENT_CONFIG_URL";
const MODE_ENV_KEY = "ZCODE_DYNAMIC_WORKFLOW_MODE";

function createMockApiClient(handler: (url: URL) => Response): ApiClient & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async request(input) {
      const url = new URL(String(input));
      requests.push(url.toString());
      return handler(url);
    },
  };
}

function envelope(configs: unknown): Response {
  return Response.json({ code: 0, data: { configs } }, { status: 200 });
}

afterEach(() => {
  delete process.env[URL_ENV_KEY];
  delete process.env[MODE_ENV_KEY];
});

describe("MikikoClientConfigService.getDynamicWorkflowClientConfig", () => {
  it("自建源下发 onDemand 时按远端生效", async () => {
    const client = createMockApiClient(() =>
      envelope({ dynamicWorkflow: { mode: "onDemand" }, share: { publishPerMinutePerIp: 5 } }),
    );
    const service = createMikikoClientConfigService({ apiClient: client });
    const config = await service.getDynamicWorkflowClientConfig();
    assert.equal(config.mode, "onDemand");
    assert.equal(config.source, "remote");
    assert.equal(client.requests[0], "https://agent.mikiko.ai/api/v1/client/configs");
  });

  it("本地 env 覆盖优先于远端与失败回落", async () => {
    process.env[MODE_ENV_KEY] = "disabled";
    const client = createMockApiClient(() => envelope({ dynamicWorkflow: { mode: "alwaysOn" } }));
    const service = createMikikoClientConfigService({ apiClient: client });
    const config = await service.getDynamicWorkflowClientConfig();
    assert.equal(config.mode, "disabled");
    assert.equal(config.source, "override");
  });

  it("自建源请求失败时 fail-open 回落 alwaysOn（工作流入口不得被配置面故障关闭）", async () => {
    const client = createMockApiClient(() => new Response("boom", { status: 503 }));
    const service = createMikikoClientConfigService({ apiClient: client });
    const config = await service.getDynamicWorkflowClientConfig();
    assert.equal(config.mode, "alwaysOn");
    assert.equal(config.source, "default");
  });

  it("远端成功但未下发 dynamicWorkflow 视为服务端明确关闭", async () => {
    const client = createMockApiClient(() => envelope({}));
    const service = createMikikoClientConfigService({ apiClient: client });
    const config = await service.getDynamicWorkflowClientConfig();
    assert.equal(config.mode, "disabled");
    assert.equal(config.source, "default");
  });

  it("MIKIKO_CLIENT_CONFIG_URL=disabled 时不发起请求且 fail-open 回落 alwaysOn（review S6）", async () => {
    process.env[URL_ENV_KEY] = "disabled";
    const client = createMockApiClient(() => {
      throw new Error("不应发起请求");
    });
    const service = createMikikoClientConfigService({ apiClient: client });
    const config = await service.getDynamicWorkflowClientConfig();
    assert.equal(client.requests.length, 0);
    assert.equal(config.mode, "alwaysOn");
    assert.equal(config.source, "default");
  });

  it("快照缓存：TTL 内重复读取合并为一次请求", async () => {
    let callCount = 0;
    const client = createMockApiClient(() => {
      callCount += 1;
      return envelope({ dynamicWorkflow: { mode: "alwaysOn" } });
    });
    const service = createMikikoClientConfigService({ apiClient: client });
    await service.getDynamicWorkflowClientConfig();
    await service.getSharePublishRateLimit();
    assert.equal(callCount, 1);
  });
});

describe("MikikoClientConfigService.getSharePublishRateLimit", () => {
  it("返回自建源下发的限流值；缺失/非法返回 null", async () => {
    let payload: unknown = { share: { publishPerMinutePerIp: 3 } };
    const client = createMockApiClient(() => envelope(payload));
    const service = createMikikoClientConfigService({ apiClient: client });
    assert.equal(await service.getSharePublishRateLimit({ forceRefresh: true }), 3);

    payload = { share: { publishPerMinutePerIp: "bogus" } };
    assert.equal(await service.getSharePublishRateLimit({ forceRefresh: true }), null);

    payload = {};
    assert.equal(await service.getSharePublishRateLimit({ forceRefresh: true }), null);
  });

  it("请求失败返回 null（服务端强制兜底，客户端仅提示）", async () => {
    const client = createMockApiClient(() => new Response("down", { status: 500 }));
    const service = createMikikoClientConfigService({ apiClient: client });
    assert.equal(await service.getSharePublishRateLimit(), null);
  });
});
