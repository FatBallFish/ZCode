import { describe, expect, it } from "vitest";
import { isMessageEnabled } from "../src/app/app-config-options.js";
describe("Mikiko message environment compatibility", () => {
  it("reads the product namespace and keeps legacy reads", () => {
    expect(isMessageEnabled({ MIKIKO_MESSAGE_ENABLED: "1" })).toBe(true);
    expect(isMessageEnabled({ ZCODE_MESSAGE_ENABLED: "true" })).toBe(true);
    expect(isMessageEnabled({ MIKIKO_MESSAGE_ENABLED: "0", ZCODE_MESSAGE_ENABLED: "true" })).toBe(false);
  });
});
