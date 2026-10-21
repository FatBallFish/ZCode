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

test("production smoke is explicit and keeps absolute-path execution requirements", () => {
  assert.deepEqual(parseOptions(["--production"]), { execute: false, production: true });
  assert.throws(() => parseOptions(["--production", "--execute"]), /--native.*--gateway/);
});

test("controlled button selection never accepts a field with the same identifier", () => {
  const result = {
    structuredContent: {
      truncated: false,
      stop_reason: "complete",
      matches: [
        { index: 1, role: "AXTextField", identifier: "button" },
        { index: 2, role: "AXButton", identifier: "button" },
      ],
    },
  };
  assert.equal(selectFixtureElement(result, "button", "AXButton").index, 2);
});

test("production execution requires the exact permission App identity", () => {
  assert.throws(
    () =>
      parseOptions([
        "--production",
        "--execute",
        "--native",
        "/fixture/native",
        "--gateway",
        "/fixture/server.mjs",
      ]),
    /--native-app/,
  );
});

test("fixture readiness rejects staged thumbnails and off-display windows", async () => {
  const { isFixtureReady } = await import("../../smoke-mikiko-computer-use.mjs");
  const ready = {
    windowId: 42,
    active: true,
    visible: true,
    intersectsDisplay: true,
    cgBounds: { width: 540, height: 213 },
  };
  assert.equal(isFixtureReady(ready), true);
  for (const partial of [
    { active: false },
    { visible: false },
    { intersectsDisplay: false },
    { cgBounds: { width: 192, height: 99 } },
    { windowId: 0 },
  ])
    assert.equal(isFixtureReady({ ...ready, ...partial }), false);
  assert.equal(isFixtureReady(undefined), false);
});

test("native action failure is not mislabeled as missing permission by its tool name", async () => {
  const { classifyNativeSmokeFailure } = await import("../../smoke-mikiko-computer-use.mjs");
  assert.equal(
    classifyNativeSmokeFailure({ accessibilityTrusted: true, screenCaptureGranted: true }),
    "failed",
  );
  assert.equal(
    classifyNativeSmokeFailure({ accessibilityTrusted: false, screenCaptureGranted: true }),
    "blocked",
  );
  assert.equal(classifyNativeSmokeFailure(undefined), "failed");
});

test("uncertain-click acceptance requires explicit production execution", () => {
  assert.throws(() => parseOptions(["--expect-unconfirmed-click"]), /production.*execute/);
  const options = parseOptions([
    "--production",
    "--execute",
    "--expect-unconfirmed-click",
    "--native",
    "/fixture/native",
    "--native-app",
    "/fixture/App.app",
    "--gateway",
    "/fixture/server.mjs",
  ]);
  assert.equal(options.expectUnconfirmedClick, true);
});
