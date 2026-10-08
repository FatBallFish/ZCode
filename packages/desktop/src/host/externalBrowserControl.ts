import { createExternalCdpRegistry, parseExternalCdpConfiguration } from "@zcode/adapters/browser";
import {
  DEFAULT_EXTERNAL_CDP_CONFIGURATION,
  type BrowserBackendDescriptor,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserClientMode,
} from "@zcode/shared";

interface Scope {
  sessionId: string;
  turnId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: BrowserClientMode;
  sessionContext?: "live" | "cached";
}
interface Execute extends Scope {
  browserId?: string;
  browserGeneration?: number;
  command: BrowserCommand;
  requestId?: string;
}
interface Executor {
  list(input?: Scope): Promise<BrowserBackendDescriptor[]>;
  execute(input: Execute): Promise<BrowserCommandResult>;
}

/**
 * 内置默认配置常量在 @zcode/shared（main 解析注入与 host 兜底共用）：
 * 不配置任何来源时按默认端口 9333 挂载一个实例，实现「零配置可用」。
 */
const EXTERNAL_DESCRIPTOR_PREFIX = "cdp:external:";

export interface DesktopExternalBrowserControl {
  list(scope?: Scope): Promise<BrowserBackendDescriptor[]>;
  execute(input: Execute): Promise<BrowserCommandResult>;
  /** main 推送已解析的最终配置（ExternalBrowserConfigChanged）；热重建 registry。 */
  applyConfiguration(config: string, remoteControlEnabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export function createDesktopExternalBrowserControl(
  iab: Executor,
  configuration?: string,
  options: { remoteControlEnabled?: boolean } = {},
): DesktopExternalBrowserControl {
  let currentConfig = configuration ?? DEFAULT_EXTERNAL_CDP_CONFIGURATION;
  let remoteControlEnabled = options.remoteControlEnabled ?? true;
  let runtime = createExternalCdpRegistry(parseExternalCdpConfiguration(currentConfig));
  let port = runtime.browserControlPort;
  // 可见性策略（spec）：回放/恢复上下文（cached）不得驱动活跃浏览器；手机远控 live 链路
  // 默认可用，可用设置关闭。所有权键不含 remoteSessionId——手机与桌面驱动同一 logical
  // session 共享 owned pages，会话结束按既有语义清理。
  const allow = (scope: Scope) =>
    scope.sessionContext !== "cached" && (!scope.remoteSessionId || remoteControlEnabled);
  const sessionId = (scope: Scope) =>
    JSON.stringify([
      scope.workspaceIdentity?.trim() ||
        scope.workspaceKey ||
        scope.workspacePath ||
        scope.sessionId,
      scope.sessionId,
    ]);
  return {
    async list(scope?: Scope): Promise<BrowserBackendDescriptor[]> {
      const existing = await iab.list(scope);
      if (!scope || !allow(scope)) return existing;
      const descriptors = await port.list({ sessionId: sessionId(scope), turnId: scope.turnId });
      return [...existing, ...descriptors];
    },
    async execute(input: Execute): Promise<BrowserCommandResult> {
      if (input.browserId?.startsWith(EXTERNAL_DESCRIPTOR_PREFIX)) {
        // 前缀即外部实例：未发现过的 ID 也走 external 端口按 backend_unavailable 拒绝，
        // 不能静默落回 IAB。
        if (!allow(input) || input.browserGeneration === undefined) {
          return {
            ok: false,
            elapsedMs: 0,
            error: {
              code: "backend_unavailable",
              message:
                input.remoteSessionId && !remoteControlEnabled
                  ? "External CDP remote control is disabled in settings."
                  : "External CDP requires an allowed live session.",
            },
          };
        }
        return await port.execute({
          requestId: input.requestId,
          browserId: input.browserId,
          browserGeneration: input.browserGeneration,
          sessionId: sessionId(input),
          turnId: input.turnId,
          command: input.command,
        });
      }
      if (allow(input)) {
        const scope = { sessionId: sessionId(input), turnId: input.turnId };
        if (input.command.method === "closeSession") await port.closeSession?.(scope);
        if (input.command.method === "turnEnded") await port.turnEnded?.(scope);
      }
      return await iab.execute(input);
    },
    async applyConfiguration(config: string, nextRemoteControlEnabled: boolean): Promise<void> {
      // 先解析校验新配置：非法时抛错并保留旧 runtime（main 推送前已校验，这里兜底）。
      parseExternalCdpConfiguration(config);
      remoteControlEnabled = nextRemoteControlEnabled;
      if (config === currentConfig) return;
      const previous = runtime;
      currentConfig = config;
      // 先同步换上新 registry 再异步关闭旧的：close 会取消在途请求并失效旧 generation，
      // agent 下次发现拿到新 generation，不重放写入（安全 detach 语义与补丁一致）。
      runtime = createExternalCdpRegistry(parseExternalCdpConfiguration(config));
      port = runtime.browserControlPort;
      await previous.close().catch(() => undefined);
    },
    async close(): Promise<void> {
      await runtime.close();
    },
  };
}
