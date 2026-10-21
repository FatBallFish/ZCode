import { describe, expect, it } from "vitest";
import { createComputerUseController } from "./controller.js";
import type { NativeComputerPort, NativeResult } from "./contract.js";

const app = "dev.mikiko.computer-use.fixture";
const meta = (extra = {}) => ({
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: "one",
    turn_id: "turn-1",
    workspace_path: "/fixture",
    client_mode: "desktop-continuous",
    delivery_kind: "desktop-continuous",
    ...extra,
  },
});
const signal = () => new AbortController().signal;
const ok: NativeResult = { content: [{ type: "text", text: "actual native result" }] };
function setup(call?: NativeComputerPort["call"], timeoutMs = 1000) {
  const calls: string[] = [];
  let closed = 0;
  const native: NativeComputerPort = {
    listTools: async () =>
      ["list_apps", "get_app_state", "set_value", "click", "query"].map((name) => ({
        name,
        inputSchema: { type: "object", properties: { app: { type: "string" } } },
      })),
    call: async (name, args, abort) => {
      calls.push(name);
      return call ? call(name, args, abort) : ok;
    },
    close: async () => {
      closed++;
    },
    endTurn: async () => {},
  };
  return {
    controller: createComputerUseController(native, { allowedApps: [app], timeoutMs }),
    calls,
    closed: () => closed,
  };
}
describe("preview Computer Use admission", () => {
  it("defaults to no discoverable tools without an explicit target", async () => {
    let listed = false;
    const controller = createComputerUseController(
      {
        listTools: async () => {
          listed = true;
          return [];
        },
        call: async () => ok,
        close: async () => {},
        endTurn: async () => {},
      },
      { allowedApps: [] },
    );
    expect(await controller.listTools()).toEqual([]);
    expect(listed).toBe(false);
  });
  it("omits enumeration and rejects unknown tools without native calls", async () => {
    const { controller, calls } = setup();
    expect((await controller.listTools()).map((t) => t.name)).not.toContain("list_apps");
    await expect(controller.call("list_apps", {}, meta(), signal())).rejects.toThrow("tool-denied");
    expect(calls).toEqual([]);
  });
  it.each([
    undefined,
    meta({ runtime_scope: "subagent" }),
    meta({ remote_session_id: "remote" }),
    meta({ client_mode: "web-remote-replayable" }),
    meta({ delivery_kind: "web-remote-replayable" }),
    meta({ turn_id: "" }),
    meta({ workspace_identity: "remote:ssh:example.invalid:22:test:/fixture" }),
    meta({ workspace_path: "relative" }),
  ])("rejects untrusted context %j", async (input) => {
    const { controller, calls } = setup();
    await expect(controller.call("get_app_state", { app }, input, signal())).rejects.toThrow(
      "scope-denied",
    );
    expect(calls).toEqual([]);
  });
  it("binds session/workspace and requires per-turn per-target observation", async () => {
    const { controller, calls } = setup();
    await expect(controller.call("set_value", { app }, meta(), signal())).rejects.toThrow(
      "observation-required",
    );
    expect(await controller.call("get_app_state", { app }, meta(), signal())).toEqual(ok);
    await controller.call("set_value", { app }, meta(), signal());
    await expect(
      controller.call("set_value", { app }, meta({ turn_id: "turn-2" }), signal()),
    ).rejects.toThrow("observation-required");
    await expect(
      controller.call("get_app_state", { app }, meta({ session_id: "two" }), signal()),
    ).rejects.toThrow("identity-mismatch");
    await expect(
      controller.call("get_app_state", { app }, meta({ workspace_path: "/other" }), signal()),
    ).rejects.toThrow("identity-mismatch");
    expect(calls).toEqual(["get_app_state", "set_value"]);
  });
  it.each([
    { app: "other" },
    { app, window_placement: "agent_display" },
    { app, click_method: "global" },
    { app, key_method: "sky_key" },
    { app, unknown: true },
  ])("blocks unsafe parameters %j", async (args) => {
    const { controller, calls } = setup();
    await expect(controller.call("get_app_state", args, meta(), signal())).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("does not establish observation from failed native results", async () => {
    const { controller } = setup(async () => ({ ...ok, isError: true }));
    expect((await controller.call("get_app_state", { app }, meta(), signal())).isError).toBe(true);
    await expect(controller.call("set_value", { app }, meta(), signal())).rejects.toThrow(
      "observation-required",
    );
  });
  it("serializes calls and skips queued cancellation", async () => {
    let release!: (v: NativeResult) => void;
    const { controller, calls } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = controller.call("get_app_state", { app }, meta(), signal());
    await Promise.resolve();
    await Promise.resolve();
    const abort = new AbortController();
    const second = controller.call("get_app_state", { app }, meta(), abort.signal);
    abort.abort();
    release(ok);
    await first;
    await expect(second).rejects.toThrow("cancelled");
    expect(calls).toEqual(["get_app_state"]);
    await controller.close();
  });
  it.each(["cancel", "timeout"])(
    "invalidates in-flight native on %s even when port ignores signal",
    async (mode) => {
      const { controller, closed } = setup(() => new Promise(() => {}), 15);
      const abort = new AbortController();
      const pending = controller.call("get_app_state", { app }, meta(), abort.signal);
      await Promise.resolve();
      await Promise.resolve();
      if (mode === "cancel") abort.abort();
      await expect(pending).rejects.toThrow(mode === "cancel" ? "cancelled" : "timeout");
      await expect(controller.call("get_app_state", { app }, meta(), signal())).rejects.toThrow(
        "disposed",
      );
      expect(closed()).toBe(1);
    },
  );
  it("preserves native image and truncation payload exactly", async () => {
    const payload = {
      content: [{ type: "image", mimeType: "image/png", data: "fixture" }],
      structuredContent: { truncated: true, stop_reason: "node_limit" },
    };
    const { controller } = setup(async () => payload);
    expect(await controller.call("query", { app, text: "field" }, meta(), signal())).toEqual(
      payload,
    );
  });
  it("rejects retired turns before resetting or observing native state", async () => {
    const { controller, calls } = setup();
    await controller.call("get_app_state", { app }, meta(), signal());
    await controller.call("get_app_state", { app }, meta({ turn_id: "turn-2" }), signal());
    await expect(controller.call("get_app_state", { app }, meta(), signal())).rejects.toThrow(
      "stale-turn",
    );
    expect(calls).toEqual(["get_app_state", "get_app_state"]);
  });
  it("requires fresh full state for actions and fresh screenshot for drag", async () => {
    const { controller, calls } = setup();
    await controller.call("query", { app, text: "field" }, meta(), signal());
    await expect(controller.call("set_value", { app }, meta(), signal())).rejects.toThrow(
      "observation-required",
    );
    await controller.call(
      "get_app_state",
      { app, include_screenshot: false, include_ax: false },
      meta(),
      signal(),
    );
    await expect(controller.call("drag", { app }, meta(), signal())).rejects.toThrow(
      "screenshot-required",
    );
    await expect(controller.call("set_value", { app }, meta(), signal())).rejects.toThrow(
      "ax-observation-required",
    );
    expect(calls).toEqual(["query", "get_app_state"]);
  });
  it.each(["cancel", "timeout"])(
    "does not dispatch after %s during blocked turn reset",
    async (mode) => {
      let release!: () => void;
      let entered!: () => void;
      const resetting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let calls = 0;
      const controller = createComputerUseController(
        {
          listTools: async () => [],
          close: async () => {},
          call: async () => {
            calls++;
            return ok;
          },
          endTurn: () => {
            entered();
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
        { allowedApps: [app], timeoutMs: 15 },
      );
      await controller.call("get_app_state", { app }, meta(), signal());
      const abort = new AbortController();
      const pending = controller.call(
        "get_app_state",
        { app },
        meta({ turn_id: "turn-2" }),
        abort.signal,
      );
      await resetting;
      if (mode === "cancel") abort.abort();
      await expect(pending).rejects.toThrow(mode === "cancel" ? "cancelled" : "timeout");
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(1);
    },
  );
});
