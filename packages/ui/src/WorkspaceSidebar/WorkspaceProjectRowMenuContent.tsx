import { CopyIcon, FolderOpen, Pin, PinOff, XIcon } from "lucide-react";
import { testId } from "@zcode/shared/test-ids";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface ProjectRowMenuItemProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

interface ProjectRowMenuLabelProps {
  children: React.ReactNode;
}

interface ProjectRowMenuSeparatorProps {
  key?: string;
}

/**
 * 项目行菜单的共用内容（更多下拉与右键菜单同源，spec specs/desktop/sidebar-projects.md）。
 * 多态 Item/Label/Separator 参照 TaskActionMenuContent 模式：下拉与右键分别注入
 * DropdownMenu 系与 ContextMenu 系组件。远程同步子菜单只存在于下拉菜单，由调用方在下拉
 * 内容里自行渲染。
 */
export function WorkspaceProjectRowMenuContent({
  intl,
  tab,
  canOpenInFileManager,
  fileManagerLabel,
  isProjectPinned,
  onOpenInFileManager,
  onCopyProjectPath,
  onToggleProjectPinned,
  onRemoveProject,
  Item,
  Label,
  Separator,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  tab: WorkspaceTabState;
  /** 远程（SSH/非 WSL）或手机远控下为 false：路径只展示，不提供点击打开。 */
  canOpenInFileManager: boolean;
  fileManagerLabel: string;
  isProjectPinned: boolean;
  onOpenInFileManager: () => void;
  onCopyProjectPath: () => void;
  onToggleProjectPinned: () => void;
  onRemoveProject: () => void;
  Item: React.ComponentType<ProjectRowMenuItemProps>;
  Label: React.ComponentType<ProjectRowMenuLabelProps>;
  Separator: React.ComponentType<ProjectRowMenuSeparatorProps>;
}) {
  return (
    <>
      {canOpenInFileManager ? (
        <Item onSelect={onOpenInFileManager} title={fileManagerLabel}>
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="min-w-0 break-all font-mono text-ui-xs leading-relaxed">
            {tab.workspacePath}
          </span>
        </Item>
      ) : (
        <Label>
          <span className="block min-w-0 break-all font-mono text-ui-xs leading-relaxed text-foreground-subtle">
            {tab.workspacePath}
          </span>
        </Label>
      )}
      <Item onSelect={onCopyProjectPath}>
        <CopyIcon className="size-3.5 shrink-0" />
        {intl.formatMessage({ id: "workspaceSidebar.copyProjectPath" })}
      </Item>
      <Item onSelect={onToggleProjectPinned}>
        {isProjectPinned ? (
          <PinOff className="size-3.5 shrink-0" />
        ) : (
          <Pin className="size-3.5 shrink-0" />
        )}
        {intl.formatMessage({
          id: isProjectPinned ? "workspaceSidebar.unpinProject" : "workspaceSidebar.pinProject",
        })}
      </Item>
      <Separator />
      <Item data-testid={testId("workspace-close", tab.workspacePath)} onSelect={onRemoveProject}>
        <XIcon className="size-3.5 shrink-0" />
        {intl.formatMessage({ id: "workspaceSidebar.remove" })}
      </Item>
    </>
  );
}
