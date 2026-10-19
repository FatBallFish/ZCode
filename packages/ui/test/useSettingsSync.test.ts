// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsSync } from "@/hooks/useSettingsSync.js";

/** 意图抢占回归（2026-10-20 修复）：首启三步引导勾选导入后 reopen("manual") 与挂载
 * effect 的 firstRun 空检测并发，firstRun 迟到的「空结果自动关闭 + markHandled」
 * 曾把刚打开的迁移向导关掉（客户反馈首启不弹窗、设置页重走才正常）。 */
const context = vi.hoisted(() => ({
  service: {
    detect: vi.fn(),
    getFirstRunPromptState: vi.fn(),
    markFirstRunPromptHandled: vi.fn(),
  },
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ settingsSyncService: context.service }),
}));
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => null,
}));
vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: vi.fn(),
}));
afterEach(() => {
  cleanup();
  // vi.fn 在同文件用例间共享，必须重置调用记录与实现，避免计数串场。
  context.service.detect.mockReset();
  context.service.getFirstRunPromptState.mockReset();
  context.service.markFirstRunPromptHandled.mockReset();
});

const emptyDiscovery = { agents: [] };

describe("useSettingsSync 意图抢占", () => {
  it("firstRun 空检测在途时 reopen：迁移向导保持打开，不消费首启提示", async () => {
    const prompt = Promise.withResolvers<{ handled: boolean }>();
    const detectFirstRun = Promise.withResolvers<{ agents: never[] }>();
    const detectManual = Promise.withResolvers<{ agents: never[] }>();
    context.service.getFirstRunPromptState.mockReturnValueOnce(prompt.promise);
    context.service.detect
      .mockReturnValueOnce(detectFirstRun.promise)
      .mockReturnValueOnce(detectManual.promise);
    context.service.markFirstRunPromptHandled.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSettingsSync({ workspacePath: "/w" }));
    await act(async () => {
      prompt.resolve({ handled: false });
    });
    expect(context.service.detect).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.actions.reopen();
    });
    expect(result.current.state.open).toBe(true);

    await act(async () => {
      detectFirstRun.resolve(emptyDiscovery);
    });
    // firstRun 迟到结果被 manual 抢占：不得标记已处理、不得把 open 重置为 false。
    expect(context.service.markFirstRunPromptHandled).not.toHaveBeenCalled();
    expect(result.current.state.open).toBe(true);

    await act(async () => {
      detectManual.resolve(emptyDiscovery);
    });
    // manual 空结果保持打开，并由 manual 检测收尾 loading（不悬挂）。
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.loading).toBe(false);
    expect(context.service.markFirstRunPromptHandled).not.toHaveBeenCalled();
    expect(context.service.detect).toHaveBeenCalledTimes(2);
  });

  it("无 manual 介入的纯首启空结果：照旧标记已处理并关闭", async () => {
    context.service.getFirstRunPromptState.mockResolvedValue({ handled: false });
    context.service.detect.mockResolvedValue(emptyDiscovery);
    context.service.markFirstRunPromptHandled.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSettingsSync({ workspacePath: "/w" }));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(context.service.markFirstRunPromptHandled).toHaveBeenCalledTimes(1);
    expect(result.current.state.open).toBe(false);
    expect(result.current.state.loading).toBe(false);
  });

  it("首启提示已处理后 reopen：manual 空结果保持打开且不重复标记", async () => {
    context.service.getFirstRunPromptState.mockResolvedValue({ handled: true });
    context.service.detect.mockResolvedValue(emptyDiscovery);
    context.service.markFirstRunPromptHandled.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSettingsSync({ workspacePath: "/w" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(context.service.detect).not.toHaveBeenCalled();

    await act(async () => {
      result.current.actions.reopen();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.loading).toBe(false);
    expect(context.service.markFirstRunPromptHandled).not.toHaveBeenCalled();
  });
});
