import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ITheme } from "@xterm/xterm";
import { restrictInheritedTerminalTheme } from "@/terminal/terminalTheme.js";

describe("terminalTheme", () => {
  it("keeps app-controlled readable colors out of inherited profile colors", () => {
    const inherited = restrictInheritedTerminalTheme({
      background: "#111111",
      foreground: "#eeeeee",
      cursor: "#00ff00",
      cursorAccent: "#111111",
      red: "#ff0000",
      brightBlue: "#3399ff",
    } satisfies ITheme);

    expect(inherited).toEqual({
      red: "#ff0000",
      brightBlue: "#3399ff",
    });
  });

  it("drops inherited theme when it only contains app-controlled surface colors", () => {
    expect(
      restrictInheritedTerminalTheme({
        background: "#111111",
        foreground: "#eeeeee",
        cursor: "#00ff00",
        cursorAccent: "#111111",
      } satisfies ITheme),
    ).toBeUndefined();
  });

  it("keeps Mikiko Light terminal surface colors bound to app theme tokens", () => {
    const zaiLightBlock = readCssBlock(".theme-mikiko-light");

    expect(readCssToken(zaiLightBlock, "--color-terminal-bg")).toBe("var(--color-background)");
    expect(readCssToken(zaiLightBlock, "--color-terminal-fg")).toBe("var(--color-foreground)");
    expect(readCssToken(zaiLightBlock, "--color-terminal-cursor")).toBe("#0d0d0d");
    expect(readCssToken(zaiLightBlock, "--color-terminal-cursor-accent")).toBe(
      "var(--color-background)",
    );
  });
});

function readCssBlock(selector: string): string {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS block: ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}
function readCssToken(block: string, token: string): string | undefined {
  return block
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${token}:`))
    ?.slice(token.length + 1)
    .trim()
    .replace(/;$/, "");
}
