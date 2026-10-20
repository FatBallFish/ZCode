import { expect, it } from "vitest";
import { createThemeSkinService } from "./contract.js";
it("an absent isolated library reads as empty without creating user data", () => {
  const service = createThemeSkinService({
    rootDir: () => "/nonexistent/mikiko-contract-theme-library",
  });
  expect(service.listInstalled()).toEqual([]);
});
