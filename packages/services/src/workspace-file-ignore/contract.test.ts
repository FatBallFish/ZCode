import { describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  buildWorkspaceFileSearchIgnoreTemplate,
  syncWorkspaceFileSearchIgnoreFromGitignore,
  resetWorkspaceFileSearchIgnoreDefaults,
} from "./index.js";

describe("workspace-file-ignore public contract", () => {
  it("uses Mikiko paths and preserves user sections from a legacy marker", () => {
    expect(WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME).toBe(".mikikoignore");
    const initial = buildWorkspaceFileSearchIgnoreTemplate("build/\n");
    const legacy =
      initial.replace("Mikiko 默认排除规则", "ZCode 默认排除规则").replace("node_modules/\n", "") +
      "private/\n!keep.txt\n";
    const synced = syncWorkspaceFileSearchIgnoreFromGitignore(legacy, "dist/\n");
    expect(synced).toContain("dist/\n");
    expect(synced).not.toContain("node_modules/");
    expect(synced).toContain("private/\n!keep.txt");
    const reset = resetWorkspaceFileSearchIgnoreDefaults(legacy, null);
    expect(reset).toContain("node_modules/");
    expect(reset).toContain("build/\n");
    expect(reset).toContain("private/\n!keep.txt");
  });
});
