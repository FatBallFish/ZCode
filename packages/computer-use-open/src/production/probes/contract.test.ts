import { describe, expect, it } from "vitest";
import type { NativeResult } from "../../contract.js";
import { createProductionComputerUseController } from "../../production.js";
const app = "dev.mikiko.computer-use.fixture";
const payload: NativeResult = { content: [{ type: "text", text: "native" }] };
const signal = () => new AbortController().signal;
const meta = () => ({
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: "session",
    turn_id: "turn-1",
    workspace_path: "/fixture",
    client_mode: "desktop-continuous",
    delivery_kind: "desktop-continuous",
  },
});
describe("production native probe lifetime", () => {
  it("disposal closes an in-flight discovery exactly once and rejects its late result", async () => {
    let finish!: (value: []) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let closed = 0;
    const controller = createProductionComputerUseController(() => ({
      listTools: () => {
        enter();
        return new Promise<[]>((resolve) => {
          finish = resolve;
        });
      },
      call: async () => payload,
      endTurn: async () => {},
      close: async () => {
        closed++;
      },
    }));
    const discovery = controller.listTools();
    await entered;
    await controller.close();
    expect(closed).toBe(1);
    finish([]);
    await expect(discovery).rejects.toThrow("disposed");
    expect(closed).toBe(1);
  });
  it("failed discovery closes its probe and leaves later action on a fresh connection", async () => {
    let generation = 0;
    const closed: number[] = [];
    const controller = createProductionComputerUseController(() => {
      const own = ++generation;
      return {
        listTools: async () => {
          throw new Error("discovery failure");
        },
        call: async () => payload,
        endTurn: async () => {},
        close: async () => {
          closed.push(own);
        },
      };
    });
    await expect(controller.listTools()).rejects.toThrow("discovery failure");
    expect(closed).toEqual([1]);
    await controller.call("get_app_state", { app }, meta(), signal());
    expect(generation).toBe(2);
    await controller.close();
    expect(closed).toEqual([1, 2]);
  });
});
