import { describe, expect, it } from "vitest";
import { createCodingPlanMcpTrustedOriginRegistry } from "../src/official-mcp-auth.js";

describe("CodingPlan MCP credential destination", () => {
  it.each(["https://agent.mikiko.ai", "https://custom-product.example"])(
    "rejects the product origin %s even when it is the configured production server",
    async (productOrigin) => {
      const registry = createCodingPlanMcpTrustedOriginRegistry({
        env: { MIKIKO_ENV: "production", MIKIKO_BASE_URL: productOrigin },
      });
      expect(
        await registry.isTrusted({ origin: productOrigin, pluginId: "image-search@local" }),
      ).toMatchObject({ trusted: false, detail: "origin_mismatch" });
      expect(
        await registry.isTrusted({ origin: "https://zcode.z.ai", pluginId: "image-search@local" }),
      ).toEqual({ trusted: true, detail: "ok" });
    },
  );

  it("accepts only explicitly configured loopback fixtures without trusting remote HTTP", async () => {
    const registry = createCodingPlanMcpTrustedOriginRegistry({
      env: { MIKIKO_ENV: "production", MIKIKO_BASE_URL: "https://product.example" },
      devTrustedOriginsRaw: "http://127.0.0.1:3999,http://remote.example",
    });
    expect(
      await registry.isTrusted({ origin: "http://127.0.0.1:3999", pluginId: "fixture" }),
    ).toMatchObject({ trusted: true });
    expect(
      await registry.isTrusted({ origin: "http://remote.example", pluginId: "fixture" }),
    ).toMatchObject({ trusted: false });
  });

  it("does not equate an unrelated HTTPS target or credential-bearing URL with the account service", async () => {
    const registry = createCodingPlanMcpTrustedOriginRegistry({ env: {} });
    for (const origin of [
      "https://attacker.example",
      "https://zcode.z.ai.attacker.example",
      "https://user:password@zcode.z.ai",
    ]) {
      expect(
        await registry.isTrusted({ origin, pluginId: "official@zcode-plugins-official" }),
      ).toMatchObject({ trusted: false });
    }
  });
});
