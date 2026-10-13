import { beforeEach, describe, expect, it, vi } from "vitest";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";

const toastMock = vi.hoisted(() => vi.fn(() => 7));

vi.mock("@/components/ui/toast.js", () => ({
  toast: toastMock,
}));

const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    values?.error ? `${id}:${values.error}` : id,
};

// 开始/成功/失败的 toast 已改由 main 广播 ExportLogsProgress 统一弹出
// （见 useRootPlatformEffects），这里只兜底 invoke 层异常。

describe("runExportLogsAction", () => {
  beforeEach(() => {
    toastMock.mockClear();
  });

  it("成功导出不再本地弹 toast（统一走 main 进度广播）", async () => {
    const exportLogs = vi.fn(async () => ({ success: true }));

    await runExportLogsAction({ exportLogs }, intl);

    expect(exportLogs).toHaveBeenCalledOnce();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("返回失败结果由 main 广播 error toast，本地不重复弹", async () => {
    const exportLogs = vi.fn(async () => ({
      success: false,
      error: "not supported",
    }));

    await runExportLogsAction({ exportLogs }, intl);

    expect(exportLogs).toHaveBeenCalledOnce();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("invoke 本身抛异常时本地兜底 error toast", async () => {
    const exportLogs = vi.fn(async () => {
      throw new Error("ipc broken");
    });

    await runExportLogsAction({ exportLogs }, intl);

    expect(toastMock).toHaveBeenCalledWith("sidebar.exportLogs.error:ipc broken");
  });
});
