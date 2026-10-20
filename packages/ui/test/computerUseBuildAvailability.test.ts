// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";

const fixture = vi.hoisted(() => {
  const getStatus = vi.fn(async () => ({ available: false, reason: "fixture-unavailable" }));
  const services = { pluginManagementService: {}, cuaPermissionService: { getStatus } };
  const command = vi.fn(async () => ({ kind: "build-unavailable" }) as Record<string, string>);
  const authorize = vi.fn();
  const platform = {
    executeDesktopCommand: command as typeof command | undefined,
    openCuaPermissionOnboarding: authorize,
  };
  return { getStatus, services, command, platform, initialize: vi.fn(), authorize };
});
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => fixture.services,
  useOptionalServices: () => fixture.services,
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => fixture.platform }));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {}, update: vi.fn() }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (selector: (state: unknown) => unknown) =>
    selector({
      plugins: [{ id: "computer-use@zcode-plugins-official", enabled: true }],
      initialize: fixture.initialize,
      setEnabled: vi.fn(),
      togglingPluginId: null,
    }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixture.platform.executeDesktopCommand = fixture.command;
  fixture.command.mockResolvedValue({ kind: "build-unavailable" });
});

it("explains the missing build and never queries or authorizes the placeholder Helper", async () => {
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isMacDesktop: true,
      workspacePath: "/fixture/unavailable",
    }),
  );
  await screen.findByText("settings.computerUse.buildUnavailable.description");
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryAllByRole("switch")).toHaveLength(0);
  expect(fixture.getStatus).not.toHaveBeenCalled();
  expect(fixture.authorize).not.toHaveBeenCalled();
  expect(fixture.initialize).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("focus"));
  expect(fixture.getStatus).not.toHaveBeenCalled();
});

it("retains the real producer's macOS floor explanation", async () => {
  fixture.command.mockResolvedValue({
    kind: "macos-below-minimum",
    minimumMacOs: "12.0",
    currentMacOs: "11",
  });
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isMacDesktop: true,
      workspacePath: "/fixture/old-os",
    }),
  );
  await screen.findByText("cuaPermission.osFloorDescription");
  expect(screen.queryByText("settings.computerUse.buildUnavailable.description")).toBeNull();
});

it("keeps permission queries for a real producer on supported macOS", async () => {
  fixture.command.mockResolvedValue({ kind: "supported" });
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isMacDesktop: true,
      workspacePath: "/fixture/real-producer",
    }),
  );
  await waitFor(() => expect(fixture.getStatus).toHaveBeenCalled());
  expect(screen.queryByText("settings.computerUse.buildUnavailable.description")).toBeNull();
});

it.each(["missing-command", "command-read-failed"])(
  "preserves legacy OS-query behavior for %s without asserting a missing producer",
  async (mode) => {
    if (mode === "missing-command") fixture.platform.executeDesktopCommand = undefined;
    else fixture.command.mockRejectedValue(new Error("fixture capability read failed"));
    render(
      createElement(ComputerUseSection, {
        isDesktop: true,
        isMacDesktop: true,
        workspacePath: `/fixture/${mode}`,
      }),
    );
    await waitFor(() => expect(fixture.getStatus).toHaveBeenCalled());
    expect(screen.queryByText("settings.computerUse.buildUnavailable.description")).toBeNull();
  },
);
