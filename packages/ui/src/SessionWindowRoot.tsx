/**
 * 独立会话窗口根组件（specs/desktop/session-drag-out-window.md）。
 *
 * 会话拖出侧栏/右键「在新窗口打开会话」创建的轻量窗口：只渲染主 App 右侧的
 * 会话页（V4WorkspaceChatArea 单 pane），不带项目侧栏/页签/命令面板/引导等其余
 * 功能。复用 Root 的核心 Provider 栈（services/platform/store/tab/diffs），但
 * 跳过 App 的完整引导（onboarding、页签恢复、OAuth 等）——见 desktop main.tsx
 * 的 windowKind === "session" 分支。
 */
import { useCallback, useState } from "react";
import { LucideProvider } from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useTheme } from "@/useTheme.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;

export function SessionWindowRoot({
  services,
  platform,
  workspacePath,
  workspaceIdentity,
  sessionId,
}: {
  services: IServiceAccessor;
  platform: IPlatformService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      <TooltipProvider>
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <StoreProvider broadcastService={services.broadcastService}>
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  <SessionWindowBody
                    workspacePath={workspacePath}
                    workspaceIdentity={workspaceIdentity}
                    sessionId={sessionId}
                  />
                </DiffsWorkerPoolProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function SessionWindowBody({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  // 主题与主窗口共用同一 localStorage 键（同 partition），初始化即应用。
  useTheme();
  const [currentSessionId, setCurrentSessionId] = useState(sessionId);

  const handleSessionCreated = useCallback((createdSessionId: string) => {
    // 会话内在本窗口 /new 首发创建出新会话：无页签/侧栏可切换，就地跟进新会话。
    setCurrentSessionId(createdSessionId);
  }, []);

  const handleSessionDeleted = useCallback(() => {
    // 会话被删除后窗口失去存在意义，跟随关闭。
    window.close();
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <V4WorkspaceChatArea
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        isDesktop
        sessionId={currentSessionId}
        onSessionCreated={handleSessionCreated}
        onSessionDeleted={handleSessionDeleted}
      />
    </div>
  );
}
