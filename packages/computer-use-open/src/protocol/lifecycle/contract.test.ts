import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNativePort } from "../../native.js";
import { alive, environment, fakeNative, readAudit, start } from "../harness.test.js";

describe("SDK2 stdio gateway lifecycle", () => {
  it("closes gateway and native on frontend EOF without signal-first fallback or leaked child", async () => {
    const f = await start();
    await f.client.listTools();
    const nativePid = (await readAudit(f.auditPath)).find((e) => e.kind === "native-start")?.pid;
    expect(nativePid).toBeGreaterThan(0);
    // SDK2's installed stdio runtime first ends stdin; the preload audit catches any SIGTERM fallback.
    await f.client.close();
    await f.transport.close();
    await expect
      .poll(async () => (await readAudit(f.auditPath)).some((e) => e.kind === "native-eof"), {
        timeout: 1500,
      })
      .toBe(true);
    await expect.poll(() => alive(f.gatewayPid), { timeout: 1500 }).toBe(false);
    expect(alive(nativePid!)).toBe(false);
    const audit = await readAudit(f.auditPath);
    // Auto negotiation disposes its separate probe with SIGTERM; the connected gateway must exit on EOF.
    expect(
      audit.filter(
        (e) =>
          (e.kind === "gateway-signal" && e.pid === f.gatewayPid) || e.kind === "native-signal",
      ),
    ).toEqual([]);
    for (const entry of audit.filter((e) => e.kind === "gateway-signal"))
      expect(alive(entry.pid!)).toBe(false);
    expect(f.stderr()).toBe("");
  });

  it("closing during first native connect never starts the native audit process", async () => {
    const f = await environment();
    const launcher = join(f.directory, "fake-native-executable");
    await writeFile(launcher, `#!${process.execPath}\nrequire(${JSON.stringify(fakeNative)});\n`);
    await chmod(launcher, 0o700);
    const port = createNativePort({
      ...f.env,
      MIKIKO_COMPUTER_USE_BINARY: process.platform === "win32" ? process.execPath : launcher,
    });
    const listing = port.listTools();
    await port.close();
    await expect(listing).rejects.toThrow("disposed");
    await expect(port.listTools()).rejects.toThrow("disposed");
    await port.close();
    expect(await readAudit(f.auditPath)).toEqual([]);
  });
});
