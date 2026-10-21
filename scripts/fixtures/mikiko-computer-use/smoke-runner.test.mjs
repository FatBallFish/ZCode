import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOptions,
  selectFixtureElement,
  verifyFixtureIdentity,
} from "../../smoke-mikiko-computer-use.mjs";

test("default prepare never enables native execution", () => {
  assert.deepEqual(parseOptions([]), { execute: false });
  assert.throws(() => parseOptions(["--execute"]), /--native.*--gateway/);
  assert.throws(() => parseOptions(["--app", "Safari"]), /Unknown option/);
  assert.throws(() => parseOptions(["--native", "relative"]), /absolute/);
});

test("fixture identity pins the child PID, bundle, title and nonce", () => {
  const expected = { pid: 42, bundleId: "dev.mikiko.fixture.a", nonce: "a", title: "Fixture a" };
  const state = { ...expected, windowId: 7, fieldIdentifier: "mikiko-smoke-input-a" };
  assert.equal(verifyFixtureIdentity(state, expected), state);
  for (const field of ["pid", "bundleId", "nonce", "title"]) {
    assert.throws(
      () => verifyFixtureIdentity({ ...state, [field]: "wrong" }, expected),
      /identity/,
    );
  }
  assert.throws(() => verifyFixtureIdentity({ ...state, windowId: 0 }, expected), /window/);
});

test("element selection rejects errors, incomplete queries and ambiguous matches", () => {
  const match = {
    index: 3,
    role: "AXTextField",
    identifier: "mikiko-smoke-input-a",
    value: "initial",
  };
  const result = (matches, extra = {}) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ matches, truncated: false, stop_reason: "complete", ...extra }),
      },
    ],
  });
  assert.equal(selectFixtureElement(result([match]), match.identifier).index, 3);
  assert.throws(
    () => selectFixtureElement({ isError: true, content: [] }, match.identifier),
    /error/,
  );
  assert.throws(
    () => selectFixtureElement(result([match], { truncated: true }), match.identifier),
    /incomplete/,
  );
  assert.throws(
    () => selectFixtureElement(result([match, match]), match.identifier),
    /exactly one/,
  );
  assert.throws(
    () => selectFixtureElement(result([{ ...match, identifier: "other" }]), match.identifier),
    /exactly one/,
  );
});
