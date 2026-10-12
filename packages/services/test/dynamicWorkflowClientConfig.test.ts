import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, type ApiClient } from "@zcode/shared";
import { createMikikoClientConfigService } from "../src/model-provider/mikikoClientConfigService.js";

// 动态工作流灰度数据源已切 Mikiko 自建 client/configs（spec specs/mikiko-cloud/
// agent-endpoint-plan.md §4.1）：本地 env 覆盖最高优先且先于任何网络动作；快照缓存
// 1h + in-flight 合并；失败语义 fail-open（工作流入口不可因配置面故障被关闭），
// 仅「远端成功但未下发 dynamicWorkflow key」视为服务端明确关闭。

function createConfigsResponse(dynamicWorkflow: unknown): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      msg: "",
      data: { configs: dynamicWorkflow === undefined ? {} : { dynamicWorkflow } },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function createService(apiClient: ApiClient) {
  return createMikikoClientConfigService({ apiClient });
}

describe("getDynamicWorkflowClientConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("本地覆盖命中时直接返回，不打远端（先于任何网络动作）", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "alwaysOn");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("override must not request remote client config");
      }),
    };
    const service = createService(apiClient);

    await expect(service.getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "override",
      offeredMode: "alwaysOn",
    });
    await expect(
      service.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ source: "override" });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("覆盖值非法时忽略覆盖，仍读远端", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "on");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "onDemand" })),
    };

    await expect(createService(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "onDemand",
      enabled: true,
      source: "remote",
      offeredMode: "onDemand",
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);
  });

  it("远端下发合法 mode 时按远端裁决", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "alwaysOn" })),
    };

    await expect(createService(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
      offeredMode: "alwaysOn",
    });
  });

  it("远端成功但没有该 key 时视为关闭", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse(undefined)),
    };

    await expect(createService(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "default",
      offeredMode: "disabled",
    });
  });

  it("命中 1h 快照缓存，forceRefresh 绕过并看到新值", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(createConfigsResponse({ mode: "disabled" }))
        .mockResolvedValueOnce(createConfigsResponse({ mode: "alwaysOn" })),
    };
    const service = createService(apiClient);

    await expect(service.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    await expect(service.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);

    await expect(
      service.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ mode: "alwaysOn", enabled: true, source: "remote" });
    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });

  it("远端请求失败时 fail-open 返回 alwaysOn，不抛给调用方（工作流入口不得被关闭）", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    await expect(createService(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "default",
      offeredMode: "alwaysOn",
    });
  });

  it("请求失败但本地有覆盖时仍返回覆盖（覆盖先于任何网络动作）", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "disabled");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    await expect(createService(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "override",
      offeredMode: "disabled",
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("自建源被显式 disabled 时同样 fail-open 回落 alwaysOn", async () => {
    vi.stubEnv("MIKIKO_CLIENT_CONFIG_URL", "disabled");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "disabled" })),
    };

    await expect(createService(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "default",
      offeredMode: "alwaysOn",
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });
});
