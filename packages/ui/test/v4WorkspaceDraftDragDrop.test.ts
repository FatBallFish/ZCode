// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { ConversationPanePresentationContext } from "@/side-pane-full-view/conversationPanePresentation.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  leafPaneIds,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { WorkbenchLeafPaneProps } from "@/v4/WorkbenchPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";

const leafPaneCapture = vi.hoisted(() => ({
  props: [] as WorkbenchLeafPaneProps[],
}));

vi.mock("@/v4/WorkbenchPane.js", async () => {
  const React = await import("react");
  return {
    WorkbenchLeafPane: (props: WorkbenchLeafPaneProps) => {
      leafPaneCapture.props.push(props);
      return React.createElement("div", {
        "data-pane-id": props.paneId,
      });
    },
  };
});

vi.mock("@/v4/WorkbenchSplitDivider.js", async () => {
  const React = await import("react");
  return {
    WorkbenchSplitDivider: () => React.createElement("div", { "data-testid": "mock-divider" }),
  };
});

function resetWorkbenchState(): void {
  usePaneLayoutStore.setState({
    root: INITIAL_PANE_LAYOUT.root,
    panes: INITIAL_PANE_LAYOUT.panes,
    focusedPaneId: INITIAL_PANE_LAYOUT.focusedPaneId,
  });
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  leafPaneCapture.props = [];
}

describe("V4WorkspaceChatArea draft drag/drop", () => {
  beforeEach(resetWorkbenchState);
  afterEach(() => {
    cleanup();
    resetWorkbenchState();
  });

  it("allows dropping a sidebar session beside a draft primary pane without creating a group", () => {
    renderToStaticMarkup(
      createElement(V4WorkspaceChatArea, {
        sessionId: null,
        workspacePath: "/workspace",
      }),
    );

    const primaryPane = leafPaneCapture.props[0];
    const payload = {
      kind: "zcode/session" as const,
      sessionId: "sess-b",
      workspacePath: "/workspace",
    };

    expect(primaryPane.canDropSession?.(payload)).toBe(true);
    primaryPane.onDropSession?.(V4_PRIMARY_PANE_ID, "right", payload);

    const paneState = usePaneLayoutStore.getState();
    expect(leafPaneIds(paneState.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
    expect(paneState.panes["pane-1"]).toEqual({
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "sess-b",
    });
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });
});

it("keeps the existing split layout mounted but disables hidden/floating pane drops", () => {
  resetWorkbenchState();
  usePaneLayoutStore
    .getState()
    .splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "/workspace" });
  const before = leafPaneIds(usePaneLayoutStore.getState().root);
  const { container } = render(
    createElement(
      ConversationPanePresentationContext.Provider,
      {
        value: {
          presentation: "floating",
          reportFloatingStatus: () => {},
          reportComposerDockHeight: () => {},
        },
      },
      createElement(V4WorkspaceChatArea, { sessionId: null, workspacePath: "/workspace" }),
    ),
  );
  expect(leafPaneCapture.props).toHaveLength(2);
  expect(leafPaneCapture.props.filter((pane) => pane.hidden)).toHaveLength(1);
  for (const pane of leafPaneCapture.props) {
    expect(pane.canSplit).toBe(false);
    expect(pane.onDropSession).toBeUndefined();
    expect(pane.canDropSession).toBeUndefined();
  }
  expect(container.querySelector('[data-testid="mock-divider"]')).toBeNull();
  expect(leafPaneIds(usePaneLayoutStore.getState().root)).toEqual(before);
  leafPaneCapture.props = [];
  cleanup();
  render(createElement(V4WorkspaceChatArea, { sessionId: null, workspacePath: "/workspace" }));
  expect(leafPaneCapture.props.every((pane) => !pane.hidden && Boolean(pane.onDropSession))).toBe(
    true,
  );
  resetWorkbenchState();
});
