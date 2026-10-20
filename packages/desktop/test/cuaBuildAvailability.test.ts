import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import tsupConfig from "../tsup.config";
import { isRealComputerUseProducerInstalled } from "../scripts/computer-use-producer.mjs";
import { resolveCuaOsSupport } from "../src/main/cuaOsSupport.js";

describe("Computer Use build availability", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "reports an absent producer before OS checks on %s",
    (platform) => {
      expect(resolveCuaOsSupport(platform, "24.0.0", false)).toEqual({ kind: "build-unavailable" });
    },
  );
  it("preserves the real producer OS contracts", () => {
    expect(resolveCuaOsSupport("darwin", "24.0.0", true)).toEqual({ kind: "supported" });
    expect(resolveCuaOsSupport("darwin", "20.0.0", true)).toEqual({
      kind: "macos-below-minimum",
      minimumMacOs: "12.0",
      currentMacOs: "11",
    });
    expect(resolveCuaOsSupport("win32", "", true)).toEqual({ kind: "not-applicable" });
  });
  it("embeds the installed producer's capability in Main through the existing detection owner", () => {
    const main = (Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig]).find(
      (config) => config.name === "main",
    );
    expect(main?.define?.__MIKIKO_COMPUTER_USE_AVAILABLE__).toBe(
      JSON.stringify(
        isRealComputerUseProducerInstalled({
          desktopPackageRoot: new URL("../", import.meta.url).pathname,
        }),
      ),
    );
  });
  it.each([true, false])(
    "uses the embedded %s capability when the caller passes no override",
    async (available) => {
      const source = await readFile(
        new URL("../src/main/cuaOsSupport.ts", import.meta.url),
        "utf8",
      );
      const output = await transform(source, {
        loader: "ts",
        format: "esm",
        define: { __MIKIKO_COMPUTER_USE_AVAILABLE__: JSON.stringify(available) },
      });
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`
      );
      expect(module.resolveCuaOsSupport("darwin", "24.0.0")).toEqual({
        kind: available ? "supported" : "build-unavailable",
      });
    },
  );
});
