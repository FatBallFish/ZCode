// @vitest-environment jsdom
// Windows/Linux 本地实验平台（supported + experimental）设置页分支：
// 实验警告卡 + 复用 Mikiko 总开关/输入框入口开关 + 不订阅 macOS 权限状态。
// 渲染方式与 computerUseBuildAvailability.test.ts 保持一致（mock services/platform/i18n/store）。
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";

const fixture = vi.hoisted(() => {
  const getStatus = vi.fn(async () => ({ available: false, reason: "fixture-unavailable" }));
  const services = { pluginManagementService: {}, cuaPermissionService: { getStatus } };
  const command = vi.fn(
    async () =>
      ({ kind: "supported", backend: "mikiko-native", experimental: true }) as Record<
        string,
        string | boolean
      >,
  );
  const authorize = vi.fn();
  const platform = {
    executeDesktopCommand: command,
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
  fixture.command.mockResolvedValue({
    kind: "supported",
    backend: "mikiko-native",
    experimental: true,
  });
});

it("Windows 本地渲染实验警告卡与平台补充说明，不渲染 macOS 权限区", async () => {
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isWindowsDesktop: true,
      workspacePath: "/fixture/windows",
    }),
  );
  const notice = await screen.findByTestId("computer-use-experimental-notice");
  expect(notice.textContent).toContain("settings.computerUse.betaBadge");
  expect(notice.textContent).toContain("settings.computerUse.experimentalNotice.title");
  expect(
    within(notice).getByText("settings.computerUse.experimentalNotice.description"),
  ).toBeTruthy();
  expect(
    within(notice).getByText("settings.computerUse.experimentalNotice.windowsNote"),
  ).toBeTruthy();
  expect(screen.queryByText("settings.computerUse.experimentalNotice.linuxNote")).toBeNull();
  // 复用总开关与输入框入口开关，且总开关可用（本地 workspacePath 已传入，不因空路径置灰）。
  const masterToggle = screen.getByRole("switch", {
    name: "settings.computerUse.toggleLabel",
  });
  expect(masterToggle.hasAttribute("disabled")).toBe(false);
  expect(
    screen.getByRole("switch", { name: "settings.computerUse.composerEntry.label" }),
  ).toBeTruthy();
  // 无 TCC 权限区、授权目标提示与权限应用重启引导。
  expect(screen.queryByText("cuaPermission.perm.accessibility")).toBeNull();
  expect(screen.queryByText("cuaPermission.perm.screenRecording")).toBeNull();
  expect(screen.queryByText("settings.computerUse.native.permissionApp")).toBeNull();
  expect(screen.queryByText("settings.computerUse.native.restartHint")).toBeNull();
  // macOS Helper 权限状态不订阅。
  expect(fixture.getStatus).not.toHaveBeenCalled();
  expect(fixture.authorize).not.toHaveBeenCalled();
  // 插件 store 初始化照常（总开关可用）。
  await waitFor(() => expect(fixture.initialize).toHaveBeenCalled());
});

it("Linux 本地走实验分支并展示 AT-SPI 平台补充说明", async () => {
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      workspacePath: "/fixture/linux",
    }),
  );
  const notice = await screen.findByTestId("computer-use-experimental-notice");
  expect(
    within(notice).getByText("settings.computerUse.experimentalNotice.linuxNote"),
  ).toBeTruthy();
  expect(screen.queryByText("settings.computerUse.experimentalNotice.windowsNote")).toBeNull();
  expect(screen.queryByText("cuaPermission.perm.accessibility")).toBeNull();
  expect(fixture.getStatus).not.toHaveBeenCalled();
});

it("macOS 稳定分支不渲染实验警告卡且保持权限订阅", async () => {
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isMacDesktop: true,
      workspacePath: "/fixture/macos",
    }),
  );
  await waitFor(() => expect(fixture.getStatus).toHaveBeenCalled());
  expect(screen.queryByTestId("computer-use-experimental-notice")).toBeNull();
  expect(screen.queryByText("settings.computerUse.experimentalNotice.windowsNote")).toBeNull();
  expect(screen.queryByText("settings.computerUse.experimentalNotice.linuxNote")).toBeNull();
});

it("实验平台资源缺失仍走 build-unavailable 卡，不渲染实验分支", async () => {
  fixture.command.mockResolvedValue({ kind: "build-unavailable" });
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isWindowsDesktop: true,
      workspacePath: "/fixture/windows-missing-assets",
    }),
  );
  await screen.findByText("settings.computerUse.buildUnavailable.description");
  expect(screen.queryByTestId("computer-use-experimental-notice")).toBeNull();
});
