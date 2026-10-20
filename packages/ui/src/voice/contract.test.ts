import { afterEach, expect, it, vi } from "vitest";
import { bindVoiceInputController, useVoiceInputStore } from "./contract.js";
afterEach(() => bindVoiceInputController(null));
it("buttons forward cancellation only to the mounted controller", () => {
  const cancel = vi.fn();
  bindVoiceInputController({ cancel, toggle: () => {} });
  useVoiceInputStore.getState().cancel();
  expect(cancel).toHaveBeenCalledOnce();
  bindVoiceInputController(null);
  useVoiceInputStore.getState().cancel();
  expect(cancel).toHaveBeenCalledOnce();
});
