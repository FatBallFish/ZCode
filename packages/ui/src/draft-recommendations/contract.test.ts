import { describe, expect, it } from "vitest";
import { getRecommendedPromptPool } from "./contract.js";
describe("Mikiko draft recommendation contract", () => {
  it.each([false, true])(
    "provides localized stable candidates without product CDN requests (%s)",
    (office) => {
      const rows = getRecommendedPromptPool(office);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      for (const row of rows) {
        expect(row.prompt.cn).toBeTruthy();
        expect(row.prompt.en).toBeTruthy();
        expect(row.iconUrl ?? "").not.toMatch(/^https?:/);
      }
    },
  );
});
