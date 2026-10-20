import { describe, expect, it } from "vitest";
import {
  formatZCodeAgentProcessName,
  formatZCodeHostProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
} from "../src/process-names.js";

describe("Mikiko process display names", () => {
  it.each(["zcode", "zai", "Z.ai", "glm", "BigModel", "ZCode Preview", "Zai Worker"])(
    "does not expose the previous product label %s",
    (label) => {
      const names = [
        formatZCodeAgentProcessName(label, "/workspace/ZCode"),
        formatZCodeHostProcessName(label),
        formatZCodeRendererProcessName(label),
        formatZCodeUtilityProcessName(label),
      ];
      for (const name of names) {
        expect(name).toMatch(/^mikiko-/);
        expect(name).not.toMatch(/zcode|zai/i);
      }
    },
  );

  it("preserves ordinary labels and only formats a display name", () => {
    const workspacePath = "/workspace/my-project";
    expect(formatZCodeAgentProcessName("custom", workspacePath)).toBe(
      "mikiko-agent-custom-my-project",
    );
    expect(workspacePath).toBe("/workspace/my-project");
  });
});
