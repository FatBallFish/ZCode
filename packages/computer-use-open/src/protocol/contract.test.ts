import { describe, expect, it } from "vitest";
import { app, call, context, denied, readAudit, start } from "./harness.test.js";

describe("SDK2 stdio gateway → fake legacy native MCP", () => {
  it("initializes and narrows tool discovery without native actions", async () => {
    const f = await start();
    expect(f.client.getServerVersion()?.name).toBe("mikiko-computer-use");
    const tools = (await f.client.listTools()).tools;
    expect(tools.map((t) => t.name)).not.toContain("list_apps");
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["query", "get_app_state", "click", "set_value"]),
    );
    const click = tools.find((t) => t.name === "click")!;
    expect(click.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["app", "element_index"],
      properties: { app: { enum: [app] }, click_method: { enum: ["accessibility"] } },
    });
    expect(click.inputSchema.properties).not.toHaveProperty("x");
    expect(click.inputSchema.properties).not.toHaveProperty("unsafe_native_only");
    expect(
      tools.find((t) => t.name === "get_app_state")?.inputSchema.properties?.window_placement,
    ).toMatchObject({ enum: ["keep"] });
    const audit = await readAudit(f.auditPath);
    expect(audit.filter((e) => e.kind === "native-call")).toEqual([]);
    expect(audit.find((e) => e.kind === "native-start")).toMatchObject({
      env: { visualCursor: "0", globalPointer: "0", namespace: "mikiko-preview" },
    });
  });

  it("denies missing/remote/subagent metadata, forged arguments and unsafe targets with zero native actions", async () => {
    const f = await start();
    const good = context(f.directory);
    for (const ctx of [
      undefined,
      context(f.directory, { runtime_scope: "subagent" }),
      context(f.directory, { remote_session_id: "fixture-remote" }),
      context(f.directory, { client_mode: "web-remote-replayable" }),
      context(f.directory, { delivery_kind: "web-remote-replayable" }),
      context(f.directory, { workspace_key: "other-workspace" }),
      context(f.directory, { turn_id: "" }),
    ]) {
      denied(await call(f, "query", { app }, ctx), "scope-denied");
    }
    denied(await call(f, "query", { app, "com.zcode/request-context": good }), "scope-denied");
    denied(await call(f, "query", { app: "dev.mikiko.not-allowed" }, good), "target-denied");
    denied(
      await call(f, "get_app_state", { app, window_placement: "agent_display" }, good),
      "mode-denied",
    );
    denied(
      await call(f, "type_text", { app, text: "fixture", key_method: "sky_key" }, good),
      "mode-denied",
    );
    denied(
      await call(f, "click", { app, element_index: "7", click_method: "global" }, good),
      "mode-denied",
    );
    denied(await call(f, "list_apps", {}, good), "tool-denied");
    denied(
      await call(f, "set_value", { app, element_index: "7", value: "fixture" }, good),
      "observation-required",
    );
    expect((await readAudit(f.auditPath)).filter((e) => e.kind === "native-call")).toEqual([]);
  });

  it("preserves allowed results, errors and image/truncation data and sends a turn-end before new observation", async () => {
    const f = await start();
    const first = context(f.directory);
    expect(await call(f, "get_app_state", { app, include_ax: true }, first)).toMatchObject({
      content: [{ type: "text", text: "native:get_app_state" }],
      structuredContent: { fixture: true },
    });
    await call(f, "click", { app, element_index: "7" }, first);
    expect((await readAudit(f.auditPath)).find((e) => e.name === "click")?.args).toEqual({
      app,
      element_index: "7",
      click_method: "accessibility",
    });
    const error = await call(f, "query", { app, text: "native-error" }, first);
    expect(error).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "fixture permission-required" }],
      structuredContent: { truncated: true, stop_reason: "permission_required" },
    });
    denied(
      await call(f, "set_value", { app, value: "no authorization" }, first),
      "observation-required",
    );
    const image = await call(f, "query", { app, text: "image" }, first);
    expect(image).toMatchObject({
      content: [
        { type: "text", text: "fixture truncated query" },
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfkAAAAASUVORK5CYII=",
        },
      ],
      structuredContent: {
        truncated: true,
        stop_reason: "node_limit",
        matches: [{ index: 7, role: "AXTextField" }],
      },
    });
    const second = context(f.directory, { turn_id: "turn-2" });
    denied(
      await call(f, "set_value", { app, value: "stale element" }, second),
      "observation-required",
    );
    await call(f, "query", { app, text: "new observation" }, second);
    denied(
      await call(
        f,
        "set_value",
        { app, element_index: "7", value: "query is not full state" },
        second,
      ),
      "observation-required",
    );
    await call(f, "get_app_state", { app, include_ax: true }, second);
    await call(f, "set_value", { app, element_index: "7", value: "allowed fixture" }, second);
    denied(await call(f, "query", { app }, first), "stale-turn");
    denied(
      await call(f, "query", { app }, context(f.directory, { session_id: "different-session" })),
      "identity-mismatch",
    );
    const audit = await readAudit(f.auditPath);
    expect(audit.filter((e) => e.kind === "native-turn-ended")).toHaveLength(1);
    const turnEnd = audit.findIndex((e) => e.kind === "native-turn-ended");
    const newObservation = audit.findIndex(
      (e) => e.kind === "native-call" && e.args?.text === "new observation",
    );
    expect(turnEnd).toBeGreaterThan(-1);
    expect(turnEnd).toBeLessThan(newObservation);
    expect(audit.filter((e) => e.kind === "native-call")).toHaveLength(7);
  });
});
