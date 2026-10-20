import type {
  ZCodeProvider,
  ZCodeTaskMeta,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  RemoteTarget,
  UserInfo,
} from "@zcode/shared";
import { useState } from "react";
import { TID_WORKSPACE_HEADER } from "@zcode/shared/test-ids";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { cn } from "@/components/lib/utils.js";
import {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderState,
  WorkspaceHeaderTitleSection,
} from "@/WorkspaceHeaderSections.js";
import type { WorkspaceHeaderVariant } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeader({
  variant = "task",

  draftDropTargetController,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary,
  hasUpdateReady,
  activeTaskId,
  user,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  sessionLogPath,
  nativeSessionLogProvider,
  nativeSessionLogPath,
  nativeSessionLogExists,
  nativeSessionLogLoading,
  providerWorkspaceConfigPath,
  providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading,
  workspaceHeaderState,
  gitSummary,
  gitDirtyFileCount,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,
  isWebRemoteControl = false,

  isDesktop,
  simplifyForNarrowRemote = false,
  isSidebarVisible,
  isTerminalOpen,
  isSidePaneOpen,
  compactWindowControlsInset = false,
  hideSidePaneToggle = false,
  onRefreshGit,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onReloadSession,
  reloadSessionDisabled,
  reloadSessionPending,
}: {
  variant?: WorkspaceHeaderVariant;
  draftDropTargetController?: ConversationDropTargetController | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  hasUpdateReady: boolean;
  activeTaskId: string | null;
  user?: UserInfo | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  providerWorkspaceConfigPath: string | null;
  providerWorkspaceConfigExists: boolean;
  providerWorkspaceConfigLoading: boolean;
  workspaceHeaderState: WorkspaceHeaderState;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  reserveWindowControls?: boolean;
  /**
   * 紧凑窗控预留（会话窗口等无左侧浮层按钮组的宿主）：mac 只让开红绿灯宽度，
   * Win/Linux 内联窗控在右侧、左侧不预留。缺省 false 沿用主窗口隐藏侧栏时的
   * 大预留（红绿灯 + 侧栏切换/Logo/新建等浮层按钮组宽度）。
   */
  compactWindowControlsInset?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  isDesktop?: boolean;
  simplifyForNarrowRemote?: boolean;
  isSidebarVisible: boolean;
  isTerminalOpen: boolean;
  isSidePaneOpen: boolean;
  /** 隐藏侧面板切换按钮（会话窗口等不承载 shell 侧面板的宿主）。 */
  hideSidePaneToggle?: boolean;
  onRefreshGit: () => void;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  onReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
}) {
  const [selectedEditor, setSelectedEditor] = useState<EditorInfo | null>(null);
  const shouldOffsetHeaderForWindowControls = !isSidebarVisible;
  // Linux 与 Windows 共用内联窗控，不再预留旧悬浮窗控的标题栏区域。
  const usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop));

  let headerWindowControlsPaddingClass: string | false = false;
  if (shouldOffsetHeaderForWindowControls) {
    if (compactWindowControlsInset) {
      // 会话窗口等无左侧浮层按钮组的宿主（2026-10-15）：mac 只需让开红绿灯
      // （~78px），Win/Linux 内联窗控渲染在右侧、左侧无需预留——沿用主窗口的
      // pl-58/pl-38 会把标题推到 232px 处，视觉上"偏中间"。
      headerWindowControlsPaddingClass = isMacDesktop ? "pl-24" : false;
    } else if (isMacDesktop) {
      if (hasUpdateReady) {
        headerWindowControlsPaddingClass = isMacFullscreen ? "pl-48" : "pl-66";
      } else {
        headerWindowControlsPaddingClass = isMacFullscreen ? "pl-38" : "pl-58";
      }
    } else {
      headerWindowControlsPaddingClass = hasUpdateReady ? "pl-44" : "pl-38";
    }
  }

  return (
    <header
      data-testid={TID_WORKSPACE_HEADER}
      data-workspace-header-variant={variant}
      className={cn(
        "@container/workspace-header relative flex w-full shrink-0 h-12 border-b",
        variant === "draft" ? "border-transparent" : "border-border/50",
      )}
    >
      {variant === "draft" && draftDropTargetController?.active ? (
        <div
          className="absolute inset-0 z-40 bg-accent/55 backdrop-blur-sm pointer-events-auto [app-region:no-drag]"
          data-testid="new-task-draft-drop-mask"
          onDragOver={draftDropTargetController.onDragOver}
          onDragLeave={draftDropTargetController.onDragLeave}
          onDrop={draftDropTargetController.onDrop}
        />
      ) : null}
      <div
        className={cn(
          // 大会话 resize trace 显示 titlebar padding 动画层会触发 scrollbar-color 非合成动画；
          // 明确限定 transition-property 为 padding，避免 duration-300 退回默认 all。
          "flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 [app-region:drag] transition-[padding] duration-300",
          // 旧 caption 菜单移除后不能继续清零右边距，否则终端按钮会贴住面板边框。
          headerWindowControlsPaddingClass,
        )}
      >
        {variant === "task" || remoteTarget || workspaceIdentity || remoteSessionId ? (
          <WorkspaceHeaderTitleSection
            variant={variant}
            readOnlyReason={readOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            remoteSessionId={remoteSessionId}
            workspaceIdentity={workspaceIdentity}
            remoteTarget={remoteTarget}
            localWorkspacePath={localWorkspacePath}
            projectName={projectName}
            activeTaskTitle={activeTaskTitle}
            activeTaskChangeSummary={activeTaskChangeSummary}
            activeTaskId={activeTaskId}
            activeTraceId={activeTraceId}
            activeSessionId={activeSessionId}
            activeTaskProvider={activeTaskProvider}
            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            sessionLogPath={sessionLogPath}
            nativeSessionLogProvider={nativeSessionLogProvider}
            nativeSessionLogPath={nativeSessionLogPath}
            nativeSessionLogExists={nativeSessionLogExists}
            nativeSessionLogLoading={nativeSessionLogLoading}
            providerWorkspaceConfigPath={providerWorkspaceConfigPath}
            providerWorkspaceConfigExists={providerWorkspaceConfigExists}
            providerWorkspaceConfigLoading={providerWorkspaceConfigLoading}
            workspaceHeaderState={workspaceHeaderState}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            simplifyForNarrowRemote={simplifyForNarrowRemote}
            selectedEditor={selectedEditor}
            onReloadSession={onReloadSession}
            reloadSessionDisabled={reloadSessionDisabled}
            reloadSessionPending={reloadSessionPending}
            onRefreshGit={onRefreshGit}
          />
        ) : (
          <div className="min-w-0 flex-1" aria-hidden="true" />
        )}
        <WorkspaceHeaderActionSection
          variant={variant}
          activeTaskId={activeTaskId}
          user={user}
          readOnlyReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          remoteTarget={remoteTarget}
          isWebRemoteControl={isWebRemoteControl}
          isDesktop={isDesktop}
          isTerminalOpen={isTerminalOpen}
          isSidePaneOpen={isSidePaneOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleSidePane={onToggleSidePane}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          simplifyForNarrowRemote={simplifyForNarrowRemote}
          hideHelpMenu={false}
          hideSidePaneToggle={hideSidePaneToggle}
          showWindowControls={usesInlineWindowControls}
          // 面板操作按钮沿用 macOS 紧凑样式，Windows/Linux 窗控跟随最右侧 Header。
          onSelectedEditorChange={setSelectedEditor}
        />
      </div>
    </header>
  );
}
