import { afterEach, describe, expect, it } from "vitest";
import { useWorktreeStore } from "./index.js";
afterEach(() => useWorktreeStore.setState({ draftLocationByRootKey: {} }));
describe("worktree UI state contract", () => {
  it("isolates draft intent by canonical root key and returns to local after consumption", () => {
    const owner = useWorktreeStore.getState();
    owner.setDraftLocation("remote:host-a:/repo", { mode: "new-worktree", ref: "main" });
    expect(owner.getDraftLocation("remote:host-b:/repo").mode).toBe("local");
    expect(owner.getDraftLocation("remote:host-a:/repo")).toEqual({
      mode: "new-worktree",
      ref: "main",
    });
    owner.setDraftLocation("remote:host-a:/repo", null);
    expect(owner.getDraftLocation("remote:host-a:/repo").mode).toBe("local");
  });
});
