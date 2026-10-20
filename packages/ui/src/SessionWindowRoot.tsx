/**
 * 独立会话窗口根组件（specs/desktop/session-drag-out-window.md）。
 *
 * 会话拖出侧栏/右键「在新窗口打开会话」创建的轻量窗口：WorkspaceHeader（会话名/更多
 * 菜单/在 XXX 打开/分享/帮助/终端与侧面板切换，兼作窗口拖动区）+ 会话页（聊天区 +
 * 终端 + 侧面板的水平分栏）。复用 Root 的核心 Provider 栈，数据装配复用 App 同款
 * hooks（useWorkspaceActiveTaskState / useGitRepository / useAppPanels）。
 *
 * 2026-10-15 面板本地化：侧面板（文件预览/内置浏览器/代码审查/辅助对话/后台任务/
 * 工作流详情等）改为在会话窗口本地渲染——与主窗口共用同一 Host 的数据，但面板状态
 * （sidePaneState）是窗口内独立实例，互不串扰；主窗口会话切走不再影响本窗口的面板
 * 上下文。内置浏览器 guest 也在本窗口挂载（webviewTag 已开，attachGuest 以本窗口为
 * owner）。仅 automations 主视图这类主窗口专属页面继续经 sessionWindowPanelBridge 转发。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { LucideProvider } from "lucide-react";
import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@/session-window/contract.js";
import type { GitChangeSourceId, IPlatformService } from "@zcode/shared";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { AppWallpaperLayer } from "@/theme-skins/AppWallpaperLayer.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RequestSecurityHost } from "@/request-security-edition/index.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useTheme } from "@/useTheme.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { resolveWorkspaceShellWindowChromeClass } from "@/app-shell/workspaceShellWindowChrome.js";
import { cn } from "@/components/lib/utils.js";
import { useTaskSidePaneMemoryBridge } from "@/app-shell/useTaskSidePaneMemoryBridge.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { logger } from "@/logger.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { createSessionPanelForwarder } from "@/v4/sessionWindowPanelBridge.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginUiWorkspaceProvider } from "@/plugin-ui/index.js";

const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
/** 会话窗口竖向布局的 panel id（聊天区 + 终端）。 */
const SESSION_WINDOW_BODY_PANEL_IDS = ["session-chat", "terminal"];
/** 会话窗口水平布局的 panel id（会话列 + 侧面板；AnimatedSidePanePanel 固定 id=browser）。 */
const SESSION_WINDOW_MAIN_PANEL_IDS = ["session-conversation-column", "browser"];

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
                      <RequestSecurityHost />
                      <SessionWindowBody
                        services={services}
                        platform={platform}
                        workspacePath={workspacePath}
                        workspaceIdentity={workspaceIdentity}
                        sessionId={sessionId}
                        isMacDesktop={isMacDesktop}
                        isWindowsDesktop={isWindowsDesktop}
                      />
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
  // 侧面板首次出现（打开或存在 tab）前不挂 ResizablePanel；之后常驻（浏览器 guest 的
  // webview 需要常驻 DOM）。终端面板常驻但折叠为 0px（AnimatedTerminalPanel 内部
  // hasRenderedTerminal 负责首开后才创建会话）。
  const [hasOpenedSidePane, setHasOpenedSidePane] = useState(false);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const [gitSelectedSourceId, setGitSelectedSourceId] = useState<GitChangeSourceId>("unstaged");
  // automations 主视图是主窗口专属页面，仍转发主窗口打开。
  const forwardPanel = useMemo(
    () =>
      createSessionPanelForwarder(platform, {
        workspacePath,
        workspaceIdentity,
      }),
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

  // —— 侧面板本地状态机（与主窗口 App 同款 useAppPanels；窗口内独立实例）——
  const {
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    browserNavigationRequest,
    handleOpenCodeViewer,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings,
    handleToggleGit,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenNewSidePaneTab,
    handleOpenPluginUi,
    handleOpenPluginMarket,
    handleOpenFileManager,
    handleNavigateFileManager,
    handleOpenTerminalTab,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
  } = useAppPanels({
    workspaceAbsPath: workspacePath,
    workspaceIdentity,
    activeTaskId: currentSessionId,
    sidePaneOwnerId: currentSessionId,
    isDesktop: true,
    isWorkspaceVisible: true,
    supportsEmbeddedBrowser: true,
    platform,
    defaultWhiteboardNamePrefix: intl.formatMessage({
      id: "whiteboard.defaultName",
    }),
  });
  const activeSidePaneTab = useMemo(() => getActiveSidePaneTab(sidePaneState), [sidePaneState]);
  const isBrowserOpen = activeSidePaneTab?.type === "browser";
  const hasGitTab = sidePaneState?.tabs.some((tab) => tab.type === "git") ?? false;
  const isSidePaneOpen = !isSidePaneCollapsed;
  // 侧面板一旦出现过（打开或存在 tab）就保持挂载：浏览器 guest 的 webview 需要常驻
  // DOM（隐藏只是收起面板），卸载会销毁 guest 进程内页面。
  useEffect(() => {
    if (isSidePaneOpen || (sidePaneState?.tabs.length ?? 0) > 0) {
      setHasOpenedSidePane(true);
    }
  }, [isSidePaneOpen, sidePaneState]);
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    open: isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });
  // 终端折叠/展开必须由 owner 侧 hook 驱动 panel.collapse/resize（与主窗口 shell 同款）：
  // 只传 isVisible 不下命令时面板永不折叠，表现为「开终端顶起输入框、关掉也不回落」。
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    open: isTerminalOpen,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const { browserRestoreUrls, handleBrowserUrlChange } = useTaskSidePaneMemoryBridge({
    activeTaskId: currentSessionId,
    gitSelectedSourceId,
    setGitSelectedSourceId,
    workspaceAbsPath: workspacePath,
    workspaceIdentity,
  });
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);

  const gitState = useGitRepository({
    workspacePath,
    activeTaskId: currentSessionId,
    includeExtendedData: hasGitTab,
    refreshToken: gitRefreshVersion,
    workspaceIdentity,
  });
  const gitDirtyFileCount = useMemo(
    () => getGitDirtyFileCount(gitState.datasets),
    [gitState.datasets],
  );
  const activeGitSourceId =
    gitState.sourceOptions.find((option) => option.id === gitSelectedSourceId)?.id ??
    gitState.sourceOptions[0]?.id ??
    "unstaged";

  const handleSessionCreated = useCallback((createdSessionId: string) => {
    // 会话内在本窗口 /new 首发创建出新会话：无页签/侧栏可切换，就地跟进新会话。
    setCurrentSessionId(createdSessionId);
  }, []);

  const handleSessionDeleted = useCallback(() => {
    // 会话被删除后窗口失去存在意义，跟随关闭。
    window.close();
  }, []);

  const handleRefreshGit = useCallback(() => {
    setGitRefreshVersion((value) => value + 1);
  }, []);

  const handleOpenGitReview = useCallback(
    (sourceId?: GitChangeSourceId) => {
      if (sourceId) {
        setGitSelectedSourceId(sourceId);
      }
      handleToggleGit();
    },
    [handleToggleGit],
  );

  // 文件链接：本地工作区的文件走本地 code viewer；助手 HTML 产物走内置浏览器。
  const handleOpenFileLink = useCallback(
    async (target: MessageFileLinkTarget) => {
      try {
        const fileStat = await services.fileService.stat({
          path: target.path,
        });
        if (fileStat.type !== "file") return;
        if (
          shouldOpenAssistantHtmlInBrowser({
            path: target.path,
            workspaceIdentity: target.workspaceIdentity ?? undefined,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId ?? undefined,
          })
        ) {
          handleOpenBrowserUrl(toFileUrl(target.path));
          return;
        }
        handleOpenCodeViewer({
          type: "file",
          title: getPathLeaf(target.path),
          path: target.path,
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        });
      } catch {
        /* stat 失败（外部路径等）静默忽略。 */
      }
    },
    [handleOpenBrowserUrl, handleOpenCodeViewer, services],
  );

  // 侧面板「辅助对话」入口：与主窗口 launcher 同款——经 selectionSideChatRuntime 命令
  // 总线请求，由当前挂载的会话面板（SessionPane 已注册 opener）创建/激活辅助对话 tab。
  const workspaceKeyForSideChat = workspaceIdentity?.trim() || workspacePath;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!currentSessionId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKeyForSideChat, currentSessionId),
    );
    if (!requested) {
      logger.warn("[SessionWindow] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: currentSessionId,
        workspaceKey: workspaceKeyForSideChat,
      });
    }
  }, [currentSessionId, workspaceKeyForSideChat]);

  const screenshotSurfaceTabId = screenshotSurfaceRequest
    ? (findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)?.id ??
      null)
    : null;

  // Git 面板「查找变更」状态（主窗口在 shell 层持有；会话窗口 v1 本地只读占位，
  // 查找导航控制器不在会话窗口装配，查找 UI 展示为空查询）。
  const [fileChangeFindQuery] = useState("");
  const [fileChangeFindActiveIndex] = useState(0);
  const [fileChangeFindNavigationRequestId] = useState(0);

  // 新窗口缺少此 Provider 时插件推荐根本不挂载；动作继续归本窗口既有面板 owner。
  return (
    <PluginUiWorkspaceProvider onOpenSidePane={handleOpenPluginUi}>
      <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        {/* 主题皮肤壁纸层垫底（z-0），内容包一层定位容器（z-[1]）保证绘制在壁纸之上。 */}
        <AppWallpaperLayer />
        <div className="relative z-[1] flex h-full min-h-0 w-full flex-col">
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
            compactWindowControlsInset
            isTerminalOpen={isTerminalOpen}
            isSidePaneOpen={isSidePaneOpen}
            onRefreshGit={handleRefreshGit}
            onToggleTerminal={() => setIsTerminalOpen((open) => !open)}
            onToggleBrowser={handleToggleBrowser}
            onToggleSidePane={handleToggleSidePaneCollapse}
            onReloadSession={() => {}}
            reloadSessionDisabled
            onCreateTask={() => {}}
            onOpenWorkspace={() => {}}
          />
          {/* 与主窗口 #content 同款桌面外衬（4px 间距 + 顶部拖动垫），让面板与窗口边缘
          以及彼此之间呈现并列关系而非嵌入。 */}
          <div className="flex min-h-0 flex-1 flex-col p-1 pt-0">
            <div className="h-1 w-full [app-region:drag]" />
            {/* 水平分栏：会话列（聊天+终端）+ 侧面板；与主窗口 workspace-body-layout 同构。 */}
            <ResizablePanelGroup
              layoutId="session-window-main-layout"
              panelIds={
                hasOpenedSidePane ? SESSION_WINDOW_MAIN_PANEL_IDS : ["session-conversation-column"]
              }
              className="flex min-h-0 flex-1"
            >
              <ResizablePanel id="session-conversation-column" minSize="30%" className="min-h-0">
                <ResizablePanelGroup
                  layoutId="session-window-body-layout"
                  panelIds={SESSION_WINDOW_BODY_PANEL_IDS}
                  orientation="vertical"
                  className="flex h-full min-h-0 flex-col"
                >
                  <ResizablePanel id="session-chat" minSize="30%" className="min-h-0">
                    {/* 会话区自带圆角边框（与主窗口 conversation section 同款）：侧面板/终端
                    可见时各自成框，形成并列组件的视觉边界。 */}
                    <section
                      data-workspace-conversation-frame="true"
                      className={cn(
                        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                        isSidePaneVisible
                          ? "rounded-[var(--workspace-panel-radius)] border border-border"
                          : resolveWorkspaceShellWindowChromeClass({
                              isMacDesktop,
                              isWindowsDesktop,
                              isLinuxDesktop: !isMacDesktop && !isWindowsDesktop,
                              macOSMajorVersion: null,
                              isWindowsMaximized: false,
                              supportsNativeRoundedCorners: null,
                            }),
                        isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                      )}
                    >
                      <V4WorkspaceChatArea
                        workspacePath={workspacePath}
                        workspaceIdentity={workspaceIdentity}
                        isDesktop
                        sessionId={currentSessionId}
                        onSessionCreated={handleSessionCreated}
                        onSessionDeleted={handleSessionDeleted}
                        // 面板动作全部本地执行（2026-10-15 面板本地化）。
                        onRefreshGit={handleRefreshGit}
                        onOpenGitReview={handleOpenGitReview}
                        onOpenBrowserUrl={handleOpenBrowserUrl}
                        // automations 主视图只在主窗口承载，继续转发。
                        onOpenAutomationsMain={(target) =>
                          forwardPanel("onOpenAutomationsMain", target)
                        }
                        onOpenCodeViewer={handleOpenCodeViewer}
                        onOpenFileLink={(target) => void handleOpenFileLink(target)}
                        onOpenBackgroundBash={handleOpenBackgroundBash}
                        onOpenSubagentSession={handleOpenSubagentSession}
                        onOpenSubagentDirectory={handleOpenSubagentDirectory}
                        onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                        onOpenSelectionSideChat={handleOpenSelectionSideChat}
                        onOpenPlanDetail={handleOpenPlanDetail}
                        onOpenWorkflowRun={handleOpenWorkflowRun}
                        onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                        onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                        onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                        onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                      />
                    </section>
                  </ResizablePanel>
                  <AnimatedTerminalPanel
                    services={services}
                    workspaceAbsPath={workspacePath}
                    workspaceIdentity={workspaceIdentity}
                    openWorkspaceKeys={[workspacePath]}
                    isVisible={isTerminalVisible}
                    isWindowsDesktop={isWindowsDesktop}
                    frameClassName={cn(
                      isSidePaneVisible
                        ? "rounded-[var(--workspace-panel-radius)] border border-border"
                        : resolveWorkspaceShellWindowChromeClass({
                            isMacDesktop,
                            isWindowsDesktop,
                            isLinuxDesktop: !isMacDesktop && !isWindowsDesktop,
                            macOSMajorVersion: null,
                            isWindowsMaximized: false,
                            supportsNativeRoundedCorners: null,
                          }),
                      "rounded-t-[var(--workspace-panel-radius)] border-t",
                    )}
                    panelRef={terminalPanelRef as RefObject<PanelImperativeHandle | null>}
                    panelElementRef={terminalPanelElementRef}
                    onClose={() => setIsTerminalOpen(false)}
                    onOpenBrowserUrl={handleOpenBrowserUrl}
                  />
                </ResizablePanelGroup>
              </ResizablePanel>
              {hasOpenedSidePane ? (
                <AnimatedSidePanePanel
                  services={services}
                  isDesktop
                  isWindowsDesktop={isWindowsDesktop}
                  frameClassName="rounded-xl border border-border"
                  showWindowControls={!isMacDesktop}
                  isVisible={isSidePaneVisible}
                  onCloseSidePane={handleToggleSidePaneCollapse}
                  sidePaneState={sidePaneState}
                  recentClosedSidePaneTabs={recentClosedSidePaneTabs}
                  isBrowserOpen={isBrowserOpen}
                  supportsEmbeddedBrowser
                  workspaceAbsPath={workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  activeTaskId={currentSessionId}
                  sidePaneOwnerId={currentSessionId}
                  gitState={gitState}
                  activeGitSourceId={activeGitSourceId}
                  panelRef={sidePanePanelRef as RefObject<PanelImperativeHandle | null>}
                  panelElementRef={sidePanePanelElementRef}
                  browserNavigationRequest={browserNavigationRequest}
                  browserRestoreUrls={browserRestoreUrls}
                  screenshotSurfaceRequest={screenshotSurfaceRequest}
                  screenshotSurfaceTabId={screenshotSurfaceTabId}
                  fileChangeFindActiveIndex={fileChangeFindActiveIndex}
                  fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
                  fileChangeFindQuery={fileChangeFindQuery}
                  onFileChangeFindMatchCountChange={() => {}}
                  onCloseCodeViewer={handleCloseCodeViewer}
                  onCloseGit={handleCloseGit}
                  onActivateTab={handleActivateSidePaneTab}
                  onReorderTab={handleReorderSidePaneTab}
                  onCloseTab={handleCloseSidePaneTab}
                  onCloseOtherTabs={handleCloseOtherSidePaneTabs}
                  onCloseAllTabs={handleCloseAllSidePaneTabs}
                  onReopenClosedTab={handleReopenClosedSidePaneTab}
                  onOpenBrowserTab={handleOpenBrowserTab}
                  onOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
                  onOpenWhiteboard={handleOpenWhiteboard}
                  onOpenDeveloperTools={handleOpenDeveloperTools}
                  onOpenNewTab={handleOpenNewSidePaneTab}
                  onOpenPluginMarket={handleOpenPluginMarket}
                  onOpenFileManager={handleOpenFileManager}
                  onNavigateFileManager={handleNavigateFileManager}
                  onOpenTerminalTab={handleOpenTerminalTab}
                  onOpenReviewTab={handleToggleGit}
                  onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
                  onRevealGitFileInTree={() => {}}
                  onOpenBrowserUrl={handleOpenBrowserUrl}
                  onOpenCodeViewer={handleOpenCodeViewer}
                  onOpenFileLink={(target) => void handleOpenFileLink(target)}
                  onOpenBackgroundBash={handleOpenBackgroundBash}
                  onOpenSubagentSession={handleOpenSubagentSession}
                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                  onOpenWorkflowRun={handleOpenWorkflowRun}
                  onRefreshGit={handleRefreshGit}
                  onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
                  onBrowserUrlChange={handleBrowserUrlChange}
                  onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
                  onSelectGitSource={setGitSelectedSourceId}
                />
              ) : null}
            </ResizablePanelGroup>
          </div>
        </div>
      </div>
    </PluginUiWorkspaceProvider>
  );
}
