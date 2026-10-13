/**
 * 会话窗口 ↔ 主窗口的侧面板动作桥（specs/desktop/session-drag-out-window.md）。
 *
 * 会话窗口不承载侧面板装配（文件预览/内置浏览器/代码审查/辅助对话等的面板状态机、
 * 浏览器 Guest 宿主、截图面统一挂载在主 App）。会话窗口内触发这些动作时转发到
 * 主窗口对应 workspace 的 shell 执行（platform.forwardPanelRequestToMainWindow →
 * main 广播 → 主窗口 onMainWindowPanelRequest → WorkspaceShellLayout 注册的分发表）。
 */
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

export interface SessionPanelRequestPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  kind: string;
  args: unknown[];
}

type PanelHandler = (...args: never[]) => unknown;

/** 会话窗口侧：生成转发器（各回调闭包内调用）。 */
export function createSessionPanelForwarder(
  platform: IPlatformService,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): (kind: string, ...args: unknown[]) => void {
  return (kind, ...args) => {
    void platform
      .forwardPanelRequestToMainWindow?.({
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        kind,
        args,
      })
      .then((result) => {
        if (result && !result.ok) {
          logger.warn("[session-window] forward panel request failed", {
            kind,
            error: result.error,
          });
        }
      });
  };
}

/**
 * 主窗口侧：注册分发表并订阅转发请求。返回清理函数。
 * handler 由 WorkspaceShellLayout 用自身 props 构造（引用经 ref 保持最新）。
 */
export function bindMainWindowPanelDispatch(options: {
  platform: IPlatformService;
  workspacePath: string;
  workspaceIdentity?: string;
  getHandlers: () => Record<string, PanelHandler>;
}): () => void {
  const dispose = options.platform.onMainWindowPanelRequest?.((payload) => {
    if (payload.workspacePath !== options.workspacePath) {
      // 广播给所有主窗口，各窗口只消费自己 workspace 的请求。
      return;
    }
    const handler = options.getHandlers()[payload.kind];
    if (!handler) {
      logger.warn("[session-window] no panel handler for forwarded request", {
        kind: payload.kind,
      });
      return;
    }
    (handler as (...args: unknown[]) => unknown)(...payload.args);
  });
  return dispose ?? (() => {});
}
