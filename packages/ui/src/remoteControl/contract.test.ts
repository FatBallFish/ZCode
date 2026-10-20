import { expect, it } from "vitest";
import { parseUaSummary } from "./contract.js";
it("renders device descriptions without making a connection or receiving credentials", () => {
  expect(parseUaSummary("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBeTruthy();
});
