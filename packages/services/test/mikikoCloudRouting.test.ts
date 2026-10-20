import { expect, it } from "vitest";
import { resolveCodingPlanClientConfigUrl } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import {
  DEFAULT_PLUGIN_MARKETPLACES,
  DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL,
} from "@zcode/shared";

it("keeps CodingPlan configuration separate from self-hosted public feature configuration", () => {
  expect(resolveCodingPlanClientConfigUrl({ MIKIKO_ENV: "production" }).toString()).toBe(
    "https://agent.mikiko.ai/api/v1/coding-plan/client/configs",
  );
});
it("uses self-hosted product marketplace and relay defaults", () => {
  expect(new URL(DEFAULT_PLUGIN_MARKETPLACES[0]!.source).origin).toBe("https://agent-dl.mikiko.ai");
  expect(new URL(DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL).origin).toBe("wss://ws.mikiko.ai");
});
