import { expect, it, vi } from "vitest";
import { importCodexNativeSessions } from "./contract.js";
it("empty or whitespace-only source selection creates no CLI session or presentation row", async () => {
  const createImportedSession = vi.fn();
  const onTaskImported = vi.fn();
  const result = await importCodexNativeSessions({
    taskIndexRepo: {} as never,
    sessionIds: [" ", ""],
    createImportedSession,
    onTaskImported,
  });
  expect(result).toEqual({ imported: [], skipped: [], failed: [] });
  expect(createImportedSession).not.toHaveBeenCalled();
  expect(onTaskImported).not.toHaveBeenCalled();
});
