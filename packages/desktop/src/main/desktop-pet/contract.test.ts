import { expect, it } from "vitest";
import { sha256Hex } from "./contract.js";
it("uses deterministic content identity for the same installed asset bytes", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
