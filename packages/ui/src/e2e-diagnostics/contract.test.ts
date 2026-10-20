// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { shouldExposeE2EStoreBridge } from "./contract.js";
afterEach(() => vi.unstubAllGlobals());
it("uses the Mikiko E2E opt-in while supporting old fixture names", () => {
  expect(shouldExposeE2EStoreBridge({ VITE_MIKIKO_E2E_STORE_BRIDGE: "1" })).toBe(true);
  expect(shouldExposeE2EStoreBridge({ VITE_ZCODE_E2E_STORE_BRIDGE: "1" })).toBe(true);
  expect(
    shouldExposeE2EStoreBridge({
      VITE_MIKIKO_E2E_STORE_BRIDGE: "0",
      VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    }),
  ).toBe(false);
  expect(
    shouldExposeE2EStoreBridge({
      VITE_MIKIKO_E2E_STORE_BRIDGE: "",
      VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    }),
  ).toBe(false);
});
it("stays closed without explicit opt-in or a renderer window", () => {
  expect(shouldExposeE2EStoreBridge({})).toBe(false);
  vi.stubGlobal("window", undefined);
  expect(shouldExposeE2EStoreBridge({ VITE_MIKIKO_E2E_STORE_BRIDGE: "1" })).toBe(false);
});
