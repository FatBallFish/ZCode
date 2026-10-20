// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  SidebarTooltipProvider: ({ children }: { children: ReactNode }) => children,
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/UpdateStatusButton.js", () => ({ UpdateStatusButton: () => null }));
vi.mock("@/root/RootStartupLoading.js", () => ({ ZCodeStartupLogoBadge: () => null }));
afterEach(cleanup);

describe("desktop top actions", () => {
  it.each(["mac", "windows", "linux"])("renders one clickable action per owner on %s", (system) => {
    const toggle = vi.fn(),
      back = vi.fn(),
      forward = vi.fn();
    render(
      createElement(DesktopTopOverlay, {
        workspaceAbsPath: "/fixture",
        isDesktop: true,
        isMacDesktop: system === "mac",
        isWindowsDesktop: system === "windows",
        isSidebarVisible: true,
        updateReadyVersion: null,
        updateState: null,
        toggleSidebarShortcutLabel: "",
        newTaskShortcutLabel: "",
        goBackShortcutLabel: "",
        goForwardShortcutLabel: "",
        canTaskNavBack: true,
        canTaskNavForward: true,
        canGoBack: true,
        canGoForward: true,
        platform: {} as IPlatformService,
        onToggleSidebar: toggle,
        onGoBack: back,
        onGoForward: forward,
        onCreateTask: vi.fn(),
      }),
    );
    for (const [label, callback] of [
      ["workspaceSidebar.toggleSidebar", toggle],
      ["taskNav.back", back],
      ["taskNav.forward", forward],
    ] as const) {
      const actions = screen.getAllByRole("button", { name: label });
      expect(actions).toHaveLength(1);
      expect(actions[0]!.closest(".pointer-events-auto")).not.toBeNull();
      fireEvent.click(actions[0]!);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });
});
