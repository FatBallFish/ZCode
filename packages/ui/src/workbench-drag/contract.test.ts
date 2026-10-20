import { expect, it } from "vitest";
import {
  parseWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  WORKBENCH_SESSION_DRAG_MIME,
} from "./contract.js";
it("preserves the exact remote workspace address through the one sidebar drag payload", () => {
  const payload = {
    kind: "zcode/session" as const,
    workspacePath: "/same",
    workspaceIdentity: "remote:server:source-a:/same",
    remoteSessionId: "attachment-a",
    sessionId: "task",
  };
  expect(
    parseWorkbenchSessionDragPayload({
      types: [WORKBENCH_SESSION_DRAG_MIME],
      getData: () => serializeWorkbenchSessionDragPayload(payload),
    }),
  ).toEqual(payload);
});
