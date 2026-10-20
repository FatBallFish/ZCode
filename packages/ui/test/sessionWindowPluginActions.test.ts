// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { SessionWindowRoot } from "@/SessionWindowRoot.js";

const actions = vi.hoisted(() => ({ plugin: vi.fn(), market: vi.fn() }));
vi.mock("@/store/StoreProvider.js", () => ({
  StoreProvider: ({ children }: { children: ReactNode }) => children,
  useZCodeStore: () => null,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  TabStoreProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/root/DiffsWorkerPoolProvider.js", () => ({
  DiffsWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/AssistantCodeCommentFeatureProvider.js", () => ({
  AssistantCodeCommentFeatureProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  CodingPlanUpgradeDialogProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/request-security-edition/index.js", () => ({ RequestSecurityHost: () => null }));
vi.mock("@/WorkspaceHeader.js", () => ({ WorkspaceHeader: () => null }));
vi.mock("@/v4/V4WorkspaceChatArea.js", () => ({ V4WorkspaceChatArea: () => null }));
vi.mock("@/app-shell/AnimatedTerminalPanel.js", () => ({ AnimatedTerminalPanel: () => null }));
vi.mock("@/theme-skins/AppWallpaperLayer.js", () => ({ AppWallpaperLayer: () => null }));
vi.mock("@/components/ui/resizable.js", () => ({
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/useTheme.js", () => ({ useTheme: () => {} }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/app-shell/useWorkspaceShellZCodeState.js", () => ({
  useWorkspaceShellZCodeState: () => ({ workspaceShellZCodeState: {} }),
}));
vi.mock("@/hooks/useWorkspaceActiveTaskState.js", () => ({
  useWorkspaceActiveTaskState: () => ({ taskNativeSessionLogFile: {}, taskSessionFile: null }),
}));
vi.mock("@/hooks/useWorkspaceProviderConfigFile.js", () => ({
  useWorkspaceProviderConfigFile: () => ({}),
}));
vi.mock("@/hooks/useGitRepository.js", () => ({
  useGitRepository: () => ({ sourceOptions: [], summary: {} }),
}));
vi.mock("@/git-branch-switcher/display.js", () => ({ getGitDirtyFileCount: () => 0 }));
vi.mock("@/app-shell/useAnimatedResizablePanel.js", () => ({
  useAnimatedResizablePanel: () => ({
    panelRef: { current: null },
    panelElementRef: { current: null },
    isVisible: true,
  }),
}));
vi.mock("@/app-shell/useTaskSidePaneMemoryBridge.js", () => ({
  useTaskSidePaneMemoryBridge: () => ({ browserRestoreUrls: [] }),
}));
vi.mock("@/browser-use/useBrowserScreenshotSurfaceRequest.js", () => ({
  useBrowserScreenshotSurfaceRequest: () => null,
}));
vi.mock("@/hooks/useAppPanels.js", () => ({
  useAppPanels: () => ({
    sidePaneState: null,
    recentClosedSidePaneTabs: [],
    isSidePaneCollapsed: false,
    handleOpenPluginUi: actions.plugin,
    handleOpenPluginMarket: actions.market,
  }),
}));
vi.mock("@/app-shell/AnimatedSidePanePanel.js", async () => {
  const { useOpenPluginUi } = await import("@/plugin-ui/adapters/PluginUiProviders.js");
  return {
    AnimatedSidePanePanel: ({
      onOpenPluginMarket,
      workspaceIdentity,
      activeTaskId,
    }: Record<string, any>) => {
      const open = useOpenPluginUi();
      return createElement(
        "div",
        {},
        open
          ? createElement(
              "button",
              {
                onClick: () =>
                  open({
                    workspacePath: "/fixture",
                    workspaceIdentity,
                    parentSessionId: activeTaskId,
                    pluginId: "fixture@personal",
                    surfaceId: "panel",
                  } as any),
              },
              "Open plugin",
            )
          : null,
        createElement("button", { onClick: onOpenPluginMarket }, "View all plugins"),
      );
    },
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  render(
    createElement(SessionWindowRoot, {
      services: {} as IServiceAccessor,
      platform: {} as IPlatformService,
      workspacePath: "/fixture",
      workspaceIdentity: "identity:fixture",
      sessionId: "session-fixture",
    }),
  );
}

it("provides local plugin actions to the independent window with its identity and session", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Open plugin" }));
  expect(actions.plugin).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceIdentity: "identity:fixture",
      parentSessionId: "session-fixture",
    }),
  );
});

it("connects View all plugins to the same window's existing panel owner", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "View all plugins" }));
  expect(actions.market).toHaveBeenCalledTimes(1);
});
