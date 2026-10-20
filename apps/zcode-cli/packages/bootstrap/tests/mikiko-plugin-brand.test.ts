import { describe, expect, it } from "vitest";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";

describe("Mikiko 内置插件展示与云端资产", () => {
  it("内置插件作者使用 Mikiko，图标从自建资产域获取", () => {
    for (const plugin of OFFICIAL_PLUGIN_DEFINITIONS) {
      if (!plugin.listing) continue;
      expect(plugin.listing.author).toEqual({ name: "Mikiko", url: "https://agent.mikiko.ai" });
      if (plugin.listing.icon) {
        expect(plugin.listing.icon).toMatch(
          /^https:\/\/agent-dl\.mikiko\.ai\/mikiko\/official-plugin\/assets\//u,
        );
      }
    }
  });
});
