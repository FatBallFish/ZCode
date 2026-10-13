import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

export async function runExportLogsAction(
  platform: Pick<IPlatformService, "exportLogs">,
  intl: IntlInstance,
): Promise<void> {
  // 开始/成功/失败的 toast 由 main 广播 ExportLogsProgress 统一弹出
  // （useRootPlatformEffects 挂载），这里只兜底 invoke 层本身的异常。
  try {
    await platform.exportLogs();
  } catch (error) {
    toast(
      intl.formatMessage(
        { id: "sidebar.exportLogs.error" },
        { error: error instanceof Error ? error.message : String(error) },
      ),
    );
  }
}
