import { expect, it } from "vitest";
import { resolveCodingPlanClientConfigUrl } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import {
  DEFAULT_MIKIKO_CLIENT_CONFIG_URL,
  DEFAULT_PLUGIN_MARKETPLACES,
  DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL,
} from "@zcode/shared";

it("keeps CodingPlan configuration separate from self-hosted public feature configuration", () => {
  // Desktop/Host 套餐配置遵守官方账号例外；旧专用代理路径不能覆盖自建公共功能配置。
  const accountConfig = resolveCodingPlanClientConfigUrl({
    MIKIKO_ENV: "production",
    MIKIKO_BASE_URL: "https://agent.mikiko.ai",
  }).toString();
  expect(accountConfig).toBe("https://zcode.z.ai/api/v1/client/configs");
  expect(DEFAULT_MIKIKO_CLIENT_CONFIG_URL).toBe("https://agent.mikiko.ai/api/v1/client/configs");
  expect(accountConfig).not.toBe(DEFAULT_MIKIKO_CLIENT_CONFIG_URL);
});
it("uses self-hosted product marketplace and relay defaults", () => {
  expect(new URL(DEFAULT_PLUGIN_MARKETPLACES[0]!.source).origin).toBe("https://agent-dl.mikiko.ai");
  expect(new URL(DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL).origin).toBe("wss://ws.mikiko.ai");
});
