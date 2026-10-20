import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import { expect, it } from "vitest";
import { calculateBrowserWebRemoteControlProof } from "./contract.js";
it("self-hosted browser auth binds proof to nonce, role and device without V2 tokens", async () => {
  const vector = WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS.find(
    (entry) => entry.role === "terminal",
  )!;
  expect(
    await calculateBrowserWebRemoteControlProof(
      vector.passHash,
      vector.nonce,
      vector.role,
      vector.deviceSid,
    ),
  ).toBe(vector.proof);
  expect(
    await calculateBrowserWebRemoteControlProof(
      vector.passHash,
      "other",
      vector.role,
      vector.deviceSid,
    ),
  ).not.toBe(vector.proof);
});
