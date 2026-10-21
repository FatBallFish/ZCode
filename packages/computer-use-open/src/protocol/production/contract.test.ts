import { describe, expect, it } from "vitest";
import { app, call, context, denied, readAudit, start } from "../harness.test.js";

describe("production SDK2 gateway → legacy native MCP", () => {
  it("discovers real schemas, forces production namespace and permits bundle targets", async () => {
    const f = await start(true, {
      MIKIKO_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: "untrusted-namespace",
      MIKIKO_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: "1",
    });
    const tools = (await f.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_apps", "stop", "get_app_state"]),
    );
    expect(tools.find((t) => t.name === "list_apps")?.inputSchema.properties).toEqual({});
    expect(tools.find((t) => t.name === "drag")?.description).toContain(
      "Moves the real system mouse",
    );
    expect(tools.find((t) => t.name === "drag")?.description).toContain("foreground focus");
    expect(tools.find((t) => t.name === "drag")?.description).toContain("fresh screenshot");
    const ctx = context(f.directory);
    denied(await call(f, "list_apps", {}), "scope-denied");
    await call(f, "list_apps", {}, ctx);
    const audit = await readAudit(f.auditPath);
    expect(audit.find((e) => e.kind === "native-start")).toMatchObject({
      env: {
        namespace: "mikiko-production",
        appAgentProxyDisabled: "0",
        globalPointer: "0",
        visualCursor: "0",
      },
    });
    expect(audit.filter((e) => e.kind === "native-call").map((e) => e.name)).toEqual(["list_apps"]);
  });
  it("stop ends the owned connection, invalidates observations and can resume safely", async () => {
    const f = await start(true);
    const ctx = context(f.directory);
    await call(f, "get_app_state", { app }, ctx);
    await call(f, "set_value", { app, element_index: "7", value: "fixture" }, ctx);
    const stop = await call(f, "stop", {}, ctx);
    expect(stop.isError).not.toBe(true);
    denied(
      await call(f, "set_value", { app, element_index: "7", value: "stale" }, ctx),
      "observation-required",
    );
    await call(f, "get_app_state", { app }, ctx);
    const audit = await readAudit(f.auditPath);
    expect(audit.filter((e) => e.kind === "native-start")).toHaveLength(2);
    expect(audit.filter((e) => e.kind === "native-turn-ended")).toHaveLength(1);
    expect(audit.filter((e) => e.kind === "native-eof")).toHaveLength(1);
    expect(audit.filter((e) => e.name === "stop")).toEqual([]);
  });
  it("host completion closes lease and late notification never interrupts a newer turn", async () => {
    const f = await start(true);
    const first = context(f.directory);
    const second = context(f.directory, { turn_id: "turn-2" });
    await call(f, "get_app_state", { app }, first);
    await f.client.notification({
      method: "notifications/mikiko/turn-ended",
      params: { _meta: { "com.zcode/request-context": first } },
    });
    denied(await call(f, "get_app_state", { app }, first), "stale-turn");
    await call(f, "get_app_state", { app }, second);
    await f.client.notification({
      method: "notifications/mikiko/turn-ended",
      params: { _meta: { "com.zcode/request-context": first } },
    });
    expect(
      (await call(f, "set_value", { app, element_index: "7", value: "current" }, second)).isError,
    ).not.toBe(true);
    const audit = await readAudit(f.auditPath);
    expect(audit.filter((e) => e.kind === "native-start")).toHaveLength(2);
    expect(audit.filter((e) => e.kind === "native-turn-ended")).toHaveLength(1);
  });
  it("dispatches a side-effecting native tool only once across SDK2→SDK1", async () => {
    const f = await start(true);
    const ctx = context(f.directory);
    await call(f, "get_app_state", { app }, ctx);
    await call(f, "click", { app, element_index: "7" }, ctx);
    const nativeCalls = (await readAudit(f.auditPath)).filter(
      (e) => e.kind === "native-call" && e.name === "click",
    );
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0].args).toMatchObject({
      app,
      element_index: "7",
      click_method: "accessibility",
    });
  });
});
