import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ApiClient } from "@zcode/shared";
import { fetchMikikoBuiltinRemoteRelease } from "../src/model-provider/mikikoBuiltinRemoteConfig.js";

/** 最小合法 Release：结构与 config/provider/zcode-builtin.json 同构，供 decode 校验通过。 */
function minimalRelease(revision: number): object {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

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

const ENV_KEY = "MIKIKO_BUILTIN_CONFIG_URL";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("fetchMikikoBuiltinRemoteRelease", () => {
  it("默认请求 agent.mikiko.ai 自建端点并解析 Release", async () => {
    const client = createMockApiClient(() => Response.json(minimalRelease(7), { status: 200 }));
    const release = await fetchMikikoBuiltinRemoteRelease({ apiClient: client });
    assert.equal(release?.revision, 7);
    assert.equal(client.requests[0], "https://agent.mikiko.ai/api/v1/builtin-provider-config");
  });

  it("MIKIKO_BUILTIN_CONFIG_URL 覆盖下载地址", async () => {
    process.env[ENV_KEY] = "https://mirror.example.com/api/v1/builtin-provider-config";
    const client = createMockApiClient(() => Response.json(minimalRelease(3), { status: 200 }));
    const release = await fetchMikikoBuiltinRemoteRelease({ apiClient: client });
    assert.equal(release?.revision, 3);
    assert.equal(client.requests[0], "https://mirror.example.com/api/v1/builtin-provider-config");
  });

  it("MIKIKO_BUILTIN_CONFIG_URL=disabled 时不发起请求并返回 null", async () => {
    process.env[ENV_KEY] = "disabled";
    const client = createMockApiClient(() => {
      throw new Error("不应发起请求");
    });
    const release = await fetchMikikoBuiltinRemoteRelease({ apiClient: client });
    assert.equal(release, null);
    assert.equal(client.requests.length, 0);
  });

  it("非 2xx 响应抛出带 Mikiko 标识的错误（同步器按失败退避，不清空缓存）", async () => {
    const client = createMockApiClient(() => new Response("not found", { status: 404 }));
    await assert.rejects(
      fetchMikikoBuiltinRemoteRelease({ apiClient: client }),
      /Mikiko builtin config: HTTP 404/,
    );
  });

  it("JSON 结构非法（schemaVersion 缺失）时抛错", async () => {
    const client = createMockApiClient(() => Response.json({ revision: 1 }, { status: 200 }));
    await assert.rejects(
      fetchMikikoBuiltinRemoteRelease({ apiClient: client }),
      /Mikiko builtin config: invalid response/,
    );
  });

  it("包含退役 provider（builtin:zapi）的 Release 被整份拒绝", async () => {
    const poisoned = {
      ...minimalRelease(9),
      config: {
        providerConfigRules: {
          templateRules: [],
          providerRules: [{ id: "builtin:zapi", config: {} }],
        },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    };
    const client = createMockApiClient(() => Response.json(poisoned, { status: 200 }));
    await assert.rejects(
      fetchMikikoBuiltinRemoteRelease({ apiClient: client }),
      /Mikiko builtin config: invalid response/,
    );
  });
});
