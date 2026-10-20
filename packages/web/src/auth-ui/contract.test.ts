// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@zcode/ui", async () => {
  const { Button } = await import("@zcode/ui/button");
  return { Button };
});
import { WebLoggedInWaitingPage } from "./contract.js";
it("renders user presentation while keeping credentials outside the view", () => {
  const html = renderToStaticMarkup(
    createElement(WebLoggedInWaitingPage, {
      user: {
        id: "sample",
        username: "Mikiko user",
        displayName: "Mikiko user",
      },
    }),
  );
  expect(html).toContain("Mikiko user");
  expect(html).not.toContain("access_token");
});
