import type { EditorInfo } from "@zcode/shared";
import { AppWindowIcon, ChevronDownIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  isOpenWithDefaultAppModifierEvent,
  mergeFileOpenApps,
  openFileWithDefaultApp,
} from "@/lib/fileOpenMethods.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  stopPropagation?: boolean;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  stopPropagation = false,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const fileActions = useFileContextActions();
  const previewSource = target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  // 格式感知应用（WPS/Office/Adobe 等）只对本地文件有意义；远端 workspace 隐藏。
  const canUseLocalFileApps = target.type === "file" && !isRemoteSource;
  const [fileApps, setFileApps] = useState<EditorInfo[]>([]);
  const [fileAppsLoaded, setFileAppsLoaded] = useState(false);
  const [loadingFileApps, setLoadingFileApps] = useState(false);
  const sortedEditors = useMemo(
    () =>
      isRemoteSource && !openInEditorRemoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorRemoteTarget,
          }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget],
  );
  const mergedOpenApps = useMemo(
    () => mergeFileOpenApps(fileApps, sortedEditors),
    [fileApps, sortedEditors],
  );
  const canOpenWithDefaultApp = canUseLocalFileApps && Boolean(platform.openExternalFile);
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors || target.type !== "file") {
      return;
    }

    setLoadingEditors(true);
    try {
      setEditors(await platform.getInstalledEditors());
      setEditorsLoaded(true);
    } catch (error) {
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target]);

  const loadFileApps = useCallback(async () => {
    if (fileAppsLoaded || loadingFileApps || !canUseLocalFileApps) {
      return;
    }

    setLoadingFileApps(true);
    try {
      setFileApps(
        await platform.getInstalledAppsForFile(target.type === "file" ? target.path : ""),
      );
      setFileAppsLoaded(true);
    } catch (error) {
      logger.warn("[OpenSplitButton] 获取格式打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingFileApps(false);
    }
  }, [canUseLocalFileApps, fileAppsLoaded, loadingFileApps, platform, target]);

  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    persistLastSelectedEditorId(editor.id);
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: result.error ?? "unknown-error",
        });
      });
  };

  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  const handleOpenWithDefaultApp = () => {
    if (target.type !== "file") {
      return;
    }

    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 默认应用打开文件失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile?.(target.path)
      .then((result) => {
        if (!result?.success) {
          reportFailure(result?.error ?? "unknown-error");
        }
      })
      .catch(reportFailure);
  };

  const handlePrimaryClick = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    // Cmd/Ctrl+左键优先系统默认应用（macOS=Cmd，Windows/Linux=Ctrl）；
    // 无默认应用或失败时回落内置预览，由预览侧栏展示「不支持预览」占位。
    if (canUseLocalFileApps && isOpenWithDefaultAppModifierEvent(event)) {
      if (target.type === "file" && (await openFileWithDefaultApp(platform, target.path))) {
        return;
      }
    }
    handlePreview();
  };

  if (hideOpenWithMenu) {
    return (
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 px-2"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            void handlePrimaryClick(event);
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
      </div>
    );
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          void loadEditors();
          void loadFileApps();
        }
      }}
    >
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 pr-1.5"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            void handlePrimaryClick(event);
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            onClick={stopEventPropagation}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" side="top" className="w-44" onClick={stopEventPropagation}>
        {target.type === "website" ? (
          <DropdownMenuItem onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            <span>
              {intl.formatMessage({
                id: "chat.previewCards.openExternal",
              })}
            </span>
          </DropdownMenuItem>
        ) : (
          <>
            {canOpenWithDefaultApp ? (
              <DropdownMenuItem onSelect={handleOpenWithDefaultApp}>
                <AppWindowIcon className="size-4" />
                <span>{intl.formatMessage({ id: "chat.previewCards.openWithDefaultApp" })}</span>
              </DropdownMenuItem>
            ) : null}
            {mergedOpenApps.length > 0 ? (
              mergedOpenApps.map((app) => (
                <DropdownMenuItem key={app.id} onSelect={() => handleOpenInEditor(app)}>
                  <img src={app.iconDataUrl} alt={app.name} className="size-4 shrink-0" />
                  <span>{app.name}</span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>
                {intl.formatMessage({
                  id:
                    loadingEditors || loadingFileApps
                      ? "common.loading"
                      : "chat.previewCards.noOpenApps",
                })}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}
            >
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void fileActions.copyRelativePath({
                  path: target.path,
                  relativePath: target.previewSource?.workspacePath
                    ? getWorkspaceFileRelativePath(target.previewSource.workspacePath, target.path)
                    : target.label,
                })
              }
            >
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
