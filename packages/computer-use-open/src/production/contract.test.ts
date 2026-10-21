import { describe, expect, it } from "vitest";
import type { NativeComputerPort, NativeResult } from "../contract.js";
import { createProductionComputerUseController } from "../production.js";

const app = "dev.mikiko.computer-use.fixture";
const other = "dev.mikiko.computer-use.other";
const meta = (extra = {}) => ({
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: "session",
    turn_id: "turn-1",
    workspace_path: "/fixture",
    client_mode: "desktop-continuous",
    delivery_kind: "desktop-continuous",
    ...extra,
  },
});
const signal = () => new AbortController().signal;
const payload: NativeResult = { content: [{ type: "text", text: "native" }] };
function setup() {
  const calls: Array<{ generation: number; name: string }> = [];
  const closed: number[] = [];
  let generations = 0;
  const controller = createProductionComputerUseController((): NativeComputerPort => {
    const generation = ++generations;
    return {
      listTools: async () =>
        ["list_apps", "get_app_state", "click", "set_value", "query", "unknown"].map((name) => ({
          name,
          inputSchema: {
            type: "object",
            properties:
              name === "list_apps"
                ? {}
                : {
                    app: { type: "string" },
                    element_index: { type: "string" },
                    include_ax: { type: "boolean" },
                    include_screenshot: { type: "boolean" },
                  },
          },
        })),
      call: async (name) => {
        calls.push({ generation, name });
        return payload;
      },
      endTurn: async () => {
        calls.push({ generation, name: "turn-ended" });
      },
      close: async () => {
        closed.push(generation);
      },
    };
  });
  return { controller, calls, closed, generations: () => generations };
}
describe("production Computer Use", () => {
  it("discovers native tools and stop without preview allowlist; strips unknown methods", async () => {
    const { controller } = setup();
    const tools = await controller.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_apps",
      "get_app_state",
      "click",
      "set_value",
      "query",
      "stop",
    ]);
    expect(tools.find((t) => t.name === "list_apps")?.inputSchema).toMatchObject({
      properties: {},
      additionalProperties: false,
    });
    expect(
      tools.find((t) => t.name === "get_app_state")?.inputSchema.properties?.app,
    ).not.toHaveProperty("enum");
    await controller.close();
  });
  it("requires trustworthy context for app discovery and stop", async () => {
    const { controller, calls } = setup();
    await expect(controller.call("list_apps", {}, undefined, signal())).rejects.toThrow(
      "scope-denied",
    );
    await expect(
      controller.call("stop", {}, meta({ runtime_scope: "subagent" }), signal()),
    ).rejects.toThrow("scope-denied");
    expect(calls).toEqual([]);
    await controller.close();
  });
  it.each([
    { remote_session_id: "remote" },
    { workspace_identity: "remote:ssh:example.invalid:22:test:/fixture" },
    { delivery_kind: "web-remote-replayable" },
    { client_mode: "web-remote-replayable" },
    { workspace_key: "another" },
    { workspace_path: "relative" },
  ])("rejects non-local or inconsistent context %j before native IO", async (extra) => {
    const { controller, calls } = setup();
    await expect(controller.call("list_apps", {}, meta(extra), signal())).rejects.toThrow(
      "scope-denied",
    );
    expect(calls).toEqual([]);
    await controller.close();
  });
  it("honors opaque local identity instead of comparing only paths", async () => {
    const { controller } = setup();
    const identity = {
      workspace_identity: "  local-workspace-1  ",
      workspace_key: "local-workspace-1",
    };
    await controller.call("get_app_state", { app }, meta(identity), signal());
    await expect(
      controller.call(
        "get_app_state",
        { app },
        meta({
          ...identity,
          workspace_identity: "local-workspace-2",
          workspace_key: "local-workspace-2",
        }),
        signal(),
      ),
    ).rejects.toThrow("identity-mismatch");
    await controller.close();
  });
  it("app discovery does not grant any actions; observation binds each target", async () => {
    const { controller, calls } = setup();
    await controller.call("list_apps", {}, meta(), signal());
    await expect(controller.call("set_value", { app }, meta(), signal())).rejects.toThrow(
      "observation-required",
    );
    await controller.call("get_app_state", { app }, meta(), signal());
    await controller.call("set_value", { app }, meta(), signal());
    await expect(controller.call("set_value", { app: other }, meta(), signal())).rejects.toThrow(
      "observation-required",
    );
    expect(calls.map((c) => c.name)).toEqual(["list_apps", "get_app_state", "set_value"]);
    await controller.close();
  });
  it.each(["stop", "new-turn"])(
    "%s ends the native lease and clears observations before next action",
    async (mode) => {
      const { controller, calls, closed } = setup();
      await controller.call("get_app_state", { app }, meta(), signal());
      const nextMeta = mode === "new-turn" ? meta({ turn_id: "turn-2" }) : meta();
      if (mode === "stop") await controller.call("stop", {}, meta(), signal());
      await expect(controller.call("set_value", { app }, nextMeta, signal())).rejects.toThrow(
        "observation-required",
      );
      await controller.call("get_app_state", { app }, nextMeta, signal());
      expect(calls).toEqual([
        { generation: 1, name: "get_app_state" },
        { generation: 1, name: "turn-ended" },
        { generation: 2, name: "get_app_state" },
      ]);
      expect(closed).toEqual([1]);
      await controller.close();
      expect(closed).toEqual([1, 2]);
    },
  );
  it("stop cannot switch or reopen a retired session/turn", async () => {
    const { controller, calls } = setup();
    await controller.call("get_app_state", { app }, meta(), signal());
    await controller.call("get_app_state", { app }, meta({ turn_id: "turn-2" }), signal());
    const count = calls.length;
    await expect(controller.call("stop", {}, meta(), signal())).rejects.toThrow("stale-turn");
    await expect(
      controller.call("stop", {}, meta({ turn_id: "turn-2", session_id: "other" }), signal()),
    ).rejects.toThrow("identity-mismatch");
    expect(calls.length).toBe(count);
    await controller.close();
  });
  it.each([
    { app: "Notes" },
    { app, window_placement: "agent_display" },
    { app, click_method: "global" },
    { app, key_method: "sky_key" },
  ])("rejects unsafe or non-bundle target %j", async (args) => {
    const { controller, calls } = setup();
    await expect(controller.call("get_app_state", args, meta(), signal())).rejects.toThrow();
    expect(calls).toEqual([]);
    await controller.close();
  });
  it("trusted turn completion releases its native connection and retires that turn", async () => {
    const { controller, closed, calls } = setup();
    await controller.call("get_app_state", { app }, meta(), signal());
    await controller.endTurn!(meta());
    expect(closed).toEqual([1]);
    await expect(controller.call("get_app_state", { app }, meta(), signal())).rejects.toThrow(
      "stale-turn",
    );
    await controller.call("get_app_state", { app }, meta({ turn_id: "turn-2" }), signal());
    await controller.endTurn!(meta()); // late completion must not release the newer turn
    expect(closed).toEqual([1]);
    expect(calls.at(-1)).toEqual({ generation: 2, name: "get_app_state" });
    await controller.close();
  });
  it("completion waits for admitted IO and foreign completion cannot release the owner", async () => {
    let finish!: (value: NativeResult) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const events: string[] = [];
    const controller = createProductionComputerUseController(() => ({
      listTools: async () => [],
      call: () => {
        events.push("call");
        enter();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      endTurn: async () => {
        events.push("turn-ended");
      },
      close: async () => {
        events.push("close");
      },
    }));
    const running = controller.call("get_app_state", { app }, meta(), signal());
    await entered;
    const completion = controller.endTurn!(meta());
    expect(events).toEqual(["call"]);
    finish(payload);
    await running;
    await completion;
    expect(events).toEqual(["call", "turn-ended", "close"]);
    await expect(controller.endTurn!(meta({ session_id: "foreign" }))).rejects.toThrow(
      "identity-mismatch",
    );
    expect(events).toEqual(["call", "turn-ended", "close"]);
    await controller.close();
    await controller.endTurn!(meta());
  });
  it("failed completion closes the exact connection and invalidates the gateway without replay", async () => {
    let closed = 0;
    let called = 0;
    const controller = createProductionComputerUseController(() => ({
      listTools: async () => [],
      call: async () => {
        called++;
        return payload;
      },
      endTurn: async () => {
        throw new Error("transport lost while ending turn");
      },
      close: async () => {
        closed++;
      },
    }));
    await controller.call("get_app_state", { app }, meta(), signal());
    await expect(controller.endTurn!(meta())).rejects.toThrow("transport lost");
    await expect(
      controller.call("get_app_state", { app }, meta({ turn_id: "turn-2" }), signal()),
    ).rejects.toThrow("disposed");
    expect({ closed, called }).toEqual({ closed: 1, called: 1 });
  });
  it("empty stop/completion does not activate native and argument-bearing controls are rejected", async () => {
    const { controller, generations } = setup();
    await controller.endTurn!(meta());
    await expect(controller.call("stop", { app }, meta(), signal())).rejects.toThrow(
      "parameter-denied",
    );
    await expect(controller.call("list_apps", { app }, meta(), signal())).rejects.toThrow(
      "parameter-denied",
    );
    await controller.call("stop", {}, meta(), signal());
    expect(generations()).toBe(0);
    await controller.close();
    await expect(controller.listTools()).rejects.toThrow("disposed");
  });
  it("discovery and inventory release native clients before an idle Helper restart", async () => {
    const { controller, closed, calls } = setup();
    await controller.listTools();
    expect(closed).toEqual([1]);
    await controller.call("list_apps", {}, meta(), signal());
    expect(closed).toEqual([1, 2]);
    await controller.call("get_app_state", { app }, meta(), signal());
    expect(calls).toEqual([
      { generation: 2, name: "list_apps" },
      { generation: 3, name: "get_app_state" },
    ]);
    await controller.close();
    expect(closed).toEqual([1, 2, 3]);
  });
});
