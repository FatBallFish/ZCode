import type { RemoteTarget } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  isComputerUseUnavailableTarget,
  resolveComputerUseAvailability,
  type ComputerUseAvailabilityInput,
  type ComputerUseAvailabilityKind,
} from "../src/settings/computerUseAvailability.js";

const REMOTE_TARGETS: Array<{
  kind: ComputerUseAvailabilityKind;
  target: RemoteTarget;
  label: string;
}> = [
  { kind: "remote-ssh", label: "SSH", target: { kind: "ssh", host: "host", username: "user" } },
  { kind: "remote-wsl", label: "WSL", target: { kind: "wsl" } },
  {
    kind: "remote-docker",
    label: "Docker",
    target: { kind: "docker", container: "fixture" },
  },
  {
    kind: "remote-server",
    label: "Server",
    target: { kind: "server", url: "https://zcode.example", name: "fixture" },
  },
];

describe("resolveComputerUseAvailability", () => {
  it("macOS 本地桌面稳定支持且不带实验标记", () => {
    expect(resolveComputerUseAvailability({ isDesktop: true, isMacDesktop: true })).toEqual({
      kind: "local-macos",
      supported: true,
    });
  });

  it("Windows 本地桌面 supported + experimental", () => {
    expect(resolveComputerUseAvailability({ isDesktop: true, isWindowsDesktop: true })).toEqual({
      kind: "local-windows",
      supported: true,
      experimental: true,
    });
  });

  it("Linux 本地桌面 supported + experimental", () => {
    expect(resolveComputerUseAvailability({ isDesktop: true })).toEqual({
      kind: "local-linux",
      supported: true,
      experimental: true,
    });
  });

  it.each(REMOTE_TARGETS)("$label 远端一律不支持", ({ target }) => {
    const availability = resolveComputerUseAvailability({
      isDesktop: true,
      isMacDesktop: true,
      remoteTarget: target,
    });
    expect(availability.supported).toBe(false);
    expect(availability.experimental).toBeUndefined();
    expect(isComputerUseUnavailableTarget(availability)).toBe(true);
  });

  it("remoteSessionId 优先判定为远端（即使桌面平台标志同时为真）", () => {
    expect(
      resolveComputerUseAvailability({
        isDesktop: true,
        isWindowsDesktop: true,
        remoteSessionId: "session-1",
      }),
    ).toMatchObject({ kind: "remote-server", supported: false });
  });

  it("Web 视图不支持且不计入远端不可用占位", () => {
    const availability = resolveComputerUseAvailability({});
    expect(availability).toEqual({ kind: "web", supported: false });
    expect(isComputerUseUnavailableTarget(availability)).toBe(false);
  });
});

describe("isComputerUseUnavailableTarget", () => {
  it("本地三分支（mac/win/linux）均不命中远端不可用判定", () => {
    const inputs: ComputerUseAvailabilityInput[] = [
      { isDesktop: true, isMacDesktop: true },
      { isDesktop: true, isWindowsDesktop: true },
      { isDesktop: true },
    ];
    for (const input of inputs) {
      expect(isComputerUseUnavailableTarget(resolveComputerUseAvailability(input))).toBe(false);
    }
  });
});
