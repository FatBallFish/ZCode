// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionStatsState } from "@zcode/shared/zcode-protocol-v4";

vi.mock("../src/i18n/IntlProvider.js", async () => {
  const messages = (await import("../src/i18n/locales/en-US.js")).default as Record<
    string,
    string
  >;
  return {
    useZCodeIntl: () => ({
      locale: "en-US",
      intl: {
        formatMessage: (
          { id }: { id: string },
          values?: Record<string, string>,
        ) => {
          const template = messages[id] ?? id;
          if (values === undefined) return template;
          return template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? `{${key}}`);
        },
      },
    }),
  };
});

vi.mock("../src/components/ui/popover.js", async () => {
  const React = await import("react");
  const passthrough =
    (tag: "button" | "div") =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);
  return {
    Popover: passthrough("div"),
    PopoverTrigger: passthrough("button"),
    PopoverContent: passthrough("div"),
  };
});

import { ChatSessionStats } from "../src/chat-input-toolbar/ChatSessionStats.js";

function baseStats(overrides: Partial<SessionStatsState> = {}): SessionStatsState {
  return {
    turnCount: 3,
    stepCount: 24,
    modelDurationMs: 96_000,
    toolDurationMs: 41_000,
    ttftAvgMs: 812,
    outputTokens: 640,
    generationDurationMs: 3_200,
    liveTokensPerSecond: null,
    ...overrides,
  };
}

function renderStats(stats: SessionStatsState | null): string {
  return renderToStaticMarkup(createElement(ChatSessionStats, { sessionStats: stats }));
}

describe("ChatSessionStats 胶囊（specs/ui/session-stats.md）", () => {
  it("stats 为 null（旧 CLI）时整体不渲染", () => {
    expect(renderStats(null)).toBe("");
  });

  it("流式中显示实时 tok/s", () => {
    const html = renderStats(baseStats({ liveTokensPerSecond: 73 }));
    expect(html).toContain("3 turns 24 steps · 73 tok/s");
  });

  it("空闲时回退会话平均 TPS", () => {
    // 640 tokens / 3200ms = 200 tok/s。
    const html = renderStats(baseStats({ liveTokensPerSecond: null }));
    expect(html).toContain("3 turns 24 steps · 200 tok/s");
  });

  it("无任何 TPS 样本时只显示轮次/步数", () => {
    const html = renderStats(
      baseStats({ liveTokensPerSecond: null, outputTokens: 0, generationDurationMs: 0 }),
    );
    expect(html).toContain("3 turns 24 steps");
    expect(html).not.toContain("tok/s");
  });
});
