import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("Mikiko profile menu keeps upstream marketing rewards entry disabled", async () => {
  const source = await readFile("packages/ui/src/WorkspaceSidebarFooter.tsx", "utf8");
  expect(source).not.toContain('data-testid="rewards-menu-item"');
  expect(source).not.toContain("openRewards");
  expect(source).not.toContain("zcode.z.ai");
});

it("ordinary workspace and session window do not mount upstream product marketing", async () => {
  for (const file of ["Root.tsx", "SessionWindowRoot.tsx"]) {
    const source = await readFile(`packages/ui/src/${file}`, "utf8");
    expect(source).not.toContain("<RewardsProvider");
    expect(source).not.toContain("<MarketingTouchProvider");
    expect(source).toContain("<CodingPlanUpgradeDialogProvider>");
  }
});
