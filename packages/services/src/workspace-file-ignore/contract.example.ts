import {
  buildWorkspaceFileSearchIgnoreTemplate,
  syncWorkspaceFileSearchIgnoreFromGitignore,
} from "./index.js";

/** 用户编辑内容交回既有 FileService 写入；纯预览不创建工作区文件。 */
export function previewUpdatedIgnoreRules(currentContent?: string): string {
  return currentContent
    ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, "build/\n")
    : buildWorkspaceFileSearchIgnoreTemplate("build/\n");
}
