import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

it("内嵌网页导航保留顶部和左右间距，移除底部内边距", async () => {
  const source = await readFile("packages/ui/src/components/EmbeddedWebsiteHeader.tsx", "utf8");
  expect(source).toContain('className="bg-background px-6 py-4 pb-0 max-sm:px-4"');
});

it("菜单保留邀请好友及奖励徽标，页面标题独立为奖励中心", async () => {
  expect(await readFile("packages/ui/src/i18n/locales/zh-CN.ts", "utf8")).toContain(
    '"rewards.menuTitle": "邀请好友"',
  );
  expect(await readFile("packages/ui/src/i18n/locales/zh-CN.ts", "utf8")).toContain(
    '"rewards.menuBadge": "奖励"',
  );
  expect(await readFile("packages/ui/src/i18n/locales/en-US.ts", "utf8")).toContain(
    '"rewards.menuTitle": "Refer a friend"',
  );
  expect(await readFile("packages/ui/src/i18n/locales/en-US.ts", "utf8")).toContain(
    '"rewards.menuBadge": "Rewards"',
  );
  expect(await readFile("packages/ui/src/i18n/locales/zh-CN.ts", "utf8")).toContain(
    '"rewards.title": "奖励中心"',
  );
  expect(await readFile("packages/ui/src/i18n/locales/en-US.ts", "utf8")).toContain(
    '"rewards.title": "Rewards"',
  );
});
