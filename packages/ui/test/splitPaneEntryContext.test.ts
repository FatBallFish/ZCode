import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useV4SplitPaneEntry, V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";

function readEntry(enabled: boolean): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  function Probe() {
    captured = { ...useV4SplitPaneEntry() };
    return null;
  }
  renderToStaticMarkup(
    createElement(
      V4SplitPaneEntryProvider,
      { enabled, canOpenSession: () => true, onOpenSession: () => {} },
      createElement(Probe),
    ),
  );
  return captured;
}

describe("V4SplitPaneEntryProvider", () => {
  it("keeps the custom split controller and the disabled mobile gate on one context", () => {
    const target = { workspacePath: "/repo", sessionId: "task" };
    const enabled = readEntry(true) as {
      enabled: boolean;
      canOpenSession(target: unknown): boolean;
      openSession(target: unknown): void;
    };
    expect(enabled.enabled).toBe(true);
    expect(enabled.canOpenSession(target)).toBe(true);
    const disabled = readEntry(false) as typeof enabled;
    expect(disabled.enabled).toBe(false);
    expect(disabled.canOpenSession(target)).toBe(false);
  });
});
