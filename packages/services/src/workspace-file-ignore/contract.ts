import type { Ignore } from "ignore";

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".mikikoignore";

export type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "template"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

export interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

export interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file：.mikikoignore 已存在；template：尚未创建，content 是保存后将落盘的初始内容预览。 */
  source: "file" | "template";
}

export const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";

export const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ↑ 以上为 Mikiko 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";

export type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";
