import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SourceServerWorkspaceAliasRepo,
  SourceServerWorkspaceIdentityConflictError,
} from "./contract.js";

it("rejects an empty workspace before opening or creating either database", async () => {
  const root = await mkdtemp(join(tmpdir(), "mikiko-alias-contract-"));
  try {
    const owner = new SourceServerWorkspaceAliasRepo({
      taskDbPath: join(root, "tasks.db"),
      sessionDbPath: join(root, "sessions.db"),
      backupRoot: join(root, "backups"),
    });
    await expect(owner.resolveCanonicalWorkspaceKey({ workspacePath: "  " })).rejects.toThrow(
      "workspacePath is required",
    );
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("identity conflicts require explicit resolution and retain their conflict details", () => {
  const error = new SourceServerWorkspaceIdentityConflictError("/workspace");
  expect(error.code).toBe("workspace-task-identity-conflict");
  expect(error.retryable).toBe(false);
  expect(error.conflicts).toEqual([]);
});
