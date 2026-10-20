import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("session window keeps local pane rendering and receives the existing service owner", () => {
  const source = readFileSync(new URL("../SessionWindowRoot.tsx", import.meta.url), "utf8");
  expect(source).toContain("<ServiceProvider services={services}");
  expect(source).toContain("<AnimatedSidePanePanel");
  expect(source).toContain("onOpenFileManager={handleOpenFileManager}");
  expect(source).not.toMatch(/create(?:Local)?Host\(/);
});
