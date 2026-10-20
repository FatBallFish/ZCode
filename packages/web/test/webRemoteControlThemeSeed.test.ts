import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlInitialTheme } from "#src/web-remote-control/index.js";

describe("resolveWebRemoteControlInitialTheme", () => {
  it("uses the QR theme only when mobile localStorage has no theme", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: null,
        qrTheme: "mikiko-dark",
      }),
    ).toBe("mikiko-dark");
  });

  it("keeps the mobile local theme once the phone has chosen one", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "light",
        qrTheme: "mikiko-dark",
      }),
    ).toBe("mikiko-light");
  });

  it("treats removed theme values as invalid", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: null,
        qrTheme: "legacy-dark",
      }),
    ).toBe("mikiko-dark");
  });

  it("falls back to the web default when neither side provides a valid theme", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "midnight",
        qrTheme: undefined,
      }),
    ).toBe("mikiko-dark");
  });

  it("allows the share page to default to light without overriding an explicit theme", () => {
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "midnight",
        qrTheme: undefined,
        defaultTheme: "mikiko-light",
      }),
    ).toBe("mikiko-light");
    expect(
      resolveWebRemoteControlInitialTheme({
        storedTheme: "mikiko-dark",
        qrTheme: undefined,
        defaultTheme: "mikiko-light",
      }),
    ).toBe("mikiko-dark");
  });
});
