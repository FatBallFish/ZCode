/**
 * 独立会话窗口根组件（specs/desktop/session-drag-out-window.md）。
 *
 * 会话拖出侧栏/右键「在新窗口打开会话」创建的轻量窗口：WorkspaceHeader（会话名/更多
 * 菜单/在 XXX 打开/分享/帮助/终端切换，兼作窗口拖动区）+ 会话页（V4WorkspaceChatArea
 * 单 pane）+ 可展开终端面板；无项目侧栏/页签/命令面板。复用 Root 的核心 Provider 栈，
 * 数据装配复用 App 同款 hooks（useWorkspaceActiveTaskState / useGitRepository 等）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { LucideProvider } from "lucide-react";
import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RewardsProvider } from "@/rewards/RewardsProvider.js";
import { RequestSecurityHost } from "@/request-security-edition/index.js";
import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useTheme } from "@/useTheme.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { createSessionPanelForwarder } from "@/v4/sessionWindowPanelBridge.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
/** 会话窗口竖向布局的 panel id（聊天区 + 终端，见 ResizablePanelGroup panelIds 注释）。 */
const SESSION_WINDOW_BODY_PANEL_IDS = ["session-chat", "terminal"];

export function SessionWindowRoot({
  services,
  platform,
  workspacePath,
  workspaceIdentity,
  sessionId,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: {
  services: IServiceAccessor;
  platform: IPlatformService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      <TooltipProvider>
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <StoreProvider broadcastService={services.broadcastService}>
              <TabStoreProvider>
                <DiffsWorkerPoolProvider>
                  {/* 与 Root 同款功能 Provider（composer/聊天页依赖其 context）；
                      会话窗口只关功能入口的 UI，不裁 context 宿主——裁掉会在
                      V4ComposerToolbar 等处抛 must-be-used-within-Provider（实测）。 */}
                  <AssistantCodeCommentFeatureProvider enabled>
                    <CodingPlanUpgradeDialogProvider>
                      <RewardsProvider desktop>
                        <RequestSecurityHost />
                        <MarketingTouchProvider desktop>
                          <SessionWindowBody
                            services={services}
                            platform={platform}
                            workspacePath={workspacePath}
                            workspaceIdentity={workspaceIdentity}
                            sessionId={sessionId}
                            isMacDesktop={isMacDesktop}
                            isWindowsDesktop={isWindowsDesktop}
                          />
                        </MarketingTouchProvider>
                      </RewardsProvider>
                    </CodingPlanUpgradeDialogProvider>
                  </AssistantCodeCommentFeatureProvider>
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
  services,
  platform,
  workspacePath,
  workspaceIdentity,
  sessionId,
  isMacDesktop,
  isWindowsDesktop,
}: {
  services: IServiceAccessor;
  platform: IPlatformService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
}) {
  const { intl } = useZCodeIntl();
  // 主题与主窗口共用同一 localStorage 键（同 partition），初始化即应用。
  useTheme();
  const [currentSessionId, setCurrentSessionId] = useState(sessionId);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // 终端首次打开前不挂 ResizablePanel（否则底部预留面板空间导致输入框上移）。
  const [hasOpenedTerminal, setHasOpenedTerminal] = useState(false);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const terminalPanelRef = useRef<PanelImperativeHandle | null>(null);
  const terminalPanelElementRef = useRef<HTMLDivElement | null>(null);
  const forwardPanel = useMemo(
    () => createSessionPanelForwarder(platform, { workspacePath, workspaceIdentity }),
    [platform, workspaceIdentity, workspacePath],
  );

  // Header 数据装配：与 App 同款 hooks（会话标题/日志路径/Git 摘要/用户态）。
  const { workspaceShellZCodeState } = useWorkspaceShellZCodeState(
    workspacePath,
    workspaceIdentity,
  );
  const user = useZCodeStore((state) => state.user);
  const {
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  } = useWorkspaceActiveTaskState({
    workspaceAbsPath: workspacePath,
    activeTaskId: currentSessionId,
    workspaceIdentity,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
    intl,
  });
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspacePath,
    workspaceHeaderProvider,
    null,
    workspaceIdentity,
  );
  const gitState = useGitRepository({
    workspacePath,
    activeTaskId: currentSessionId,
    includeExtendedData: false,
    refreshToken: gitRefreshVersion,
    workspaceIdentity,
  });
  const gitDirtyFileCount = useMemo(
    () => getGitDirtyFileCount(gitState.datasets),
    [gitState.datasets],
  );

  const handleSessionCreated = useCallback((createdSessionId: string) => {
    // 会话内在本窗口 /new 首发创建出新会话：无页签/侧栏可切换，就地跟进新会话。
    setCurrentSessionId(createdSessionId);
  }, []);

  const handleSessionDeleted = useCallback(() => {
    // 会话被删除后窗口失去存在意义，跟随关闭。
    window.close();
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Header 兼作窗口拖动区（内部 [app-region:drag]，按钮区 no-drag）。 */}
      <WorkspaceHeader
        variant="task"
        workspaceAbsPath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        projectName={getPathLeaf(workspacePath) || workspacePath}
        activeTaskTitle={activeTaskTitle}
        activeTaskChangeSummary={activeTaskChangeSummary}
        hasUpdateReady={false}
        activeTaskId={currentSessionId}
        user={user}
        activeTraceId={activeTraceId}
        activeSessionId={activeSessionId}
        activeTaskProvider={activeTaskProvider}
        resolvedActiveTaskMeta={resolvedActiveTaskMeta}
        sessionLogPath={taskSessionFile?.path ?? null}
        nativeSessionLogProvider={taskNativeSessionLogFile.provider}
        nativeSessionLogPath={taskNativeSessionLogFile.path}
        nativeSessionLogExists={taskNativeSessionLogFile.exists}
        nativeSessionLogLoading={taskNativeSessionLogFile.loading}
        providerWorkspaceConfigPath={providerConfigFile.path}
        providerWorkspaceConfigExists={providerConfigFile.exists}
        providerWorkspaceConfigLoading={providerConfigFile.loading}
        workspaceHeaderState={{
          selectedProvider: workspaceShellZCodeState.selectedProvider,
        }}
        gitSummary={gitState.summary}
        gitDirtyFileCount={gitDirtyFileCount}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
        isDesktop
        // 无侧栏：让 Header 为 macOS 红绿灯 / Win&Linux 内联窗控预留左侧内边距。
        isSidebarVisible={false}
        isTerminalOpen={isTerminalOpen}
        isSidePaneOpen={false}
        // 侧面板（文件树/Git/浏览器面板）依赖 shell 级面板装配，会话窗口 v1 不承载。
        hideSidePaneToggle
        onRefreshGit={() => setGitRefreshVersion((value) => value + 1)}
        onToggleTerminal={() => {
          setIsTerminalOpen((open) => {
            if (!open) setHasOpenedTerminal(true);
            return !open;
          });
        }}
        onToggleBrowser={() => {}}
        onToggleSidePane={() => {}}
        onReloadSession={() => {}}
        reloadSessionDisabled
        onCreateTask={() => {}}
        onOpenWorkspace={() => {}}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 终端面板：首次打开前不渲染 ResizablePanel（2026-10-14 自测反馈：默认
            挂载会在底部预留面板空间导致输入框上移）。终端内容仍由 AnimatedTerminalPanel
            内部的 hasRenderedTerminal 保持首开后不卸载。 */}
        <ResizablePanelGroup
          layoutId="session-window-body-layout"
          panelIds={isTerminalOpen ? SESSION_WINDOW_BODY_PANEL_IDS : ["session-chat"]}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col"
        >
          <ResizablePanel id="session-chat" minSize="30%" className="min-h-0">
            <V4WorkspaceChatArea
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              isDesktop
              sessionId={currentSessionId}
              onSessionCreated={handleSessionCreated}
              onSessionDeleted={handleSessionDeleted}
              // 侧面板动作转发主窗口执行（面板宿主统一在主 App，见 sessionWindowPanelBridge）。
              onRefreshGit={() => forwardPanel("onRefreshGit")}
              onOpenGitReview={(sourceId) => forwardPanel("onOpenGitReview", sourceId)}
              onOpenBrowserUrl={(url) => forwardPanel("onOpenBrowserUrl", url)}
              onOpenAutomationsMain={(target) => forwardPanel("onOpenAutomationsMain", target)}
              onOpenCodeViewer={(source) => forwardPanel("onOpenCodeViewer", source)}
              onOpenFileLink={(target) => forwardPanel("onOpenFileLink", target)}
              onOpenBackgroundBash={(request) => forwardPanel("onOpenBackgroundBash", request)}
              onOpenSubagentSession={(request) => forwardPanel("onOpenSubagentSession", request)}
              onOpenSubagentDirectory={(request) =>
                forwardPanel("onOpenSubagentDirectory", request)
              }
              onSyncSubagentSessionTabs={(request) =>
                forwardPanel("onSyncSubagentSessionTabs", request)
              }
              onOpenSelectionSideChat={(request) =>
                forwardPanel("onOpenSelectionSideChat", request)
              }
              onOpenPlanDetail={(request) => forwardPanel("onOpenPlanDetail", request)}
              onOpenWorkflowRun={(request) => forwardPanel("onOpenWorkflowRun", request)}
              onOpenWorkflowArtifact={(request) => forwardPanel("onOpenWorkflowArtifact", request)}
              onOpenWorkflowRunDirectory={(request) =>
                forwardPanel("onOpenWorkflowRunDirectory", request)
              }
              onOpenWorkflowActorSession={(request) =>
                forwardPanel("onOpenWorkflowActorSession", request)
              }
              onOpenWorkflowWorkspace={(request) =>
                forwardPanel("onOpenWorkflowWorkspace", request)
              }
            />
          </ResizablePanel>
          {hasOpenedTerminal ? (
            <AnimatedTerminalPanel
              services={services}
              workspaceAbsPath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              openWorkspaceKeys={[workspacePath]}
              isVisible={isTerminalOpen}
              isWindowsDesktop={isWindowsDesktop}
              panelRef={terminalPanelRef as RefObject<PanelImperativeHandle | null>}
              panelElementRef={terminalPanelElementRef}
              onClose={() => setIsTerminalOpen(false)}
              onOpenBrowserUrl={() => {}}
            />
          ) : null}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
