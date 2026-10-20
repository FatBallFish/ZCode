import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("MikikoCC uses the injected OIDC port while self-hosted password and 2FA remain available", () => {
  const source = readFileSync(
    new URL("../settings/Sub2ApiLoginPanel.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain('props.method === "oidc"');
  expect(source).toContain("sub2ApiService.startOIDCLogin(siteId)");
  expect(source).toContain("sub2ApiService.cancelOIDCLogin(siteId)");
  expect(source).toContain("sub2ApiService.loginWith2FA(");
  expect(source).not.toContain("localStorage.setItem");
});
