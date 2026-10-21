// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MikikoComputerUseSection } from "./contract.js";
import { DesktopCommandIds } from "@zcode/shared";
import { useMikikoComputerUseActions } from "@/hooks/useMikikoComputerUseActions.js";
const fixture = vi.hoisted(() => ({
  command: vi.fn(async () => ({ success: true })),
  restart: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand: fixture.command }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ cuaPermissionService: { restartHelper: fixture.restart } }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const status = {
  available: true as const,
  backend: "mikiko-native",
  appPath: "/bundle/Mikiko Computer Use.app",
  grantOwner: "dev.mikiko.computer-use",
  grantOwnerDisplayName: "Mikiko Computer Use",
  accessibility: "denied" as const,
  screenRecording: "granted" as const,
};
function props() {
  return {
    enabled: true,
    toggling: false,
    workspacePath: "/workspace",
    status,
    onToggle: vi.fn(async () => {}),
    refresh: vi.fn(),
    composerVisible: false,
    composerSaving: false,
    onToggleComposer: vi.fn(async () => {}),
  };
}
it("shows the precise native grant target and opens only the selected permission settings command", async () => {
  const input = props();
  render(createElement(MikikoComputerUseSection, input));
  expect(screen.getByText(status.appPath)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "chat.cuaPermission.openAccessibility" }));
  await waitFor(() =>
    expect(fixture.command).toHaveBeenCalledWith(
      DesktopCommandIds.OpenMikikoComputerUseAccessibilitySettings,
    ),
  );
  expect(fixture.restart).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "chat.cuaPermission.openScreenRecording" }),
  ).toBeNull();
});
it("keeps the plugin default-off surface free from permission and restart actions", () => {
  render(createElement(MikikoComputerUseSection, { ...props(), enabled: false }));
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryByText(status.appPath)).toBeNull();
  expect(fixture.command).not.toHaveBeenCalled();
  expect(fixture.restart).not.toHaveBeenCalled();
});
it("uses the public native restart service and refreshes without enabling functional probes", async () => {
  const input = props();
  render(createElement(MikikoComputerUseSection, input));
  fireEvent.click(screen.getByRole("button", { name: "cuaPermission.modal.restartButton" }));
  await waitFor(() => expect(fixture.restart).toHaveBeenCalledWith("/workspace", undefined));
  expect(input.refresh).toHaveBeenCalledWith();
  expect(fixture.command).not.toHaveBeenCalled();
});

it("routes Screen Recording separately and reports a failed settings action", async () => {
  fixture.command.mockResolvedValueOnce({ success: false });
  render(
    createElement(MikikoComputerUseSection, {
      ...props(),
      status: { ...status, screenRecording: "denied" },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "chat.cuaPermission.openScreenRecording" }));
  await waitFor(() =>
    expect(fixture.command).toHaveBeenCalledWith(
      DesktopCommandIds.OpenMikikoComputerUseScreenRecordingSettings,
    ),
  );
});

it("keeps duplicate restart requests single-flight and fences a late workspace result", async () => {
  const pending = Promise.withResolvers<{ ok: boolean }>();
  fixture.restart.mockImplementationOnce(() => pending.promise);
  const refresh = vi.fn();
  const { result, rerender } = renderHook(
    ({ path }) => useMikikoComputerUseActions({ workspacePath: path, refresh }),
    { initialProps: { path: "/first" } },
  );
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.restart();
    second = result.current.restart();
  });
  expect(second).toBe(first);
  await waitFor(() => expect(fixture.restart).toHaveBeenCalledTimes(1));
  rerender({ path: "/second" });
  await act(async () => {
    pending.resolve({ ok: true });
    await first;
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(result.current.restarting).toBe(false);
});

it("allows another restart after a synchronous service error and does not refresh unmounted UI", async () => {
  const refresh = vi.fn();
  fixture.restart.mockImplementationOnce(() => {
    throw new Error("fixture service failure");
  });
  const { result, unmount } = renderHook(() =>
    useMikikoComputerUseActions({ workspacePath: "/workspace", refresh }),
  );
  await act(async () => {
    await result.current.restart();
  });
  await act(async () => {
    await result.current.restart();
  });
  expect(fixture.restart).toHaveBeenCalledTimes(2);
  const pending = Promise.withResolvers<{ ok: boolean }>();
  fixture.restart.mockImplementationOnce(() => pending.promise);
  let call!: Promise<void>;
  act(() => {
    call = result.current.restart();
  });
  await waitFor(() => expect(fixture.restart).toHaveBeenCalledTimes(3));
  unmount();
  refresh.mockClear();
  pending.resolve({ ok: true });
  await call;
  expect(refresh).not.toHaveBeenCalled();
});

it("keeps unknown permission facts distinct from denied", () => {
  render(
    createElement(MikikoComputerUseSection, {
      ...props(),
      status: { ...status, accessibility: "unknown", screenRecording: "unknown" },
    }),
  );
  expect(screen.getAllByText("cuaPermission.status.unknown")).toHaveLength(2);
  expect(screen.queryByText("cuaPermission.status.missing")).toBeNull();
});
