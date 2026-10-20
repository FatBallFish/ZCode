import { expect, it, vi } from "vitest";
import { createVoiceMicPermission } from "./contract.js";
it("unknown macOS microphone states fail closed and never claim granted", () => {
  const permission = createVoiceMicPermission({
    platform: "darwin",
    getMediaAccessStatus: () => "future-unknown",
    askForMediaAccess: vi.fn(async () => false),
    openExternal: vi.fn(async () => {}),
  });
  expect(permission.getStatus()).toEqual({ status: "denied" });
});
