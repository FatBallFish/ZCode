import { describe, expect, it } from "vitest";
import { mikikoCloudWorker } from "./contract.js";
describe("Mikiko cloud HTTP boundary", () => {
  it("serves health without requiring credentials or external requests", async () => {
    const response = await mikikoCloudWorker.fetch(
      new Request("https://product.example/healthz"),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
