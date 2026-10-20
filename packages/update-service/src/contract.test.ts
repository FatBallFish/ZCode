import { expect, it } from "vitest";
import { mikikoUpdateHttpWorker } from "./contract.js";
it("serves the public update health boundary without storage bindings or credentials", async () => {
  const response = await mikikoUpdateHttpWorker.fetch(
    new Request("https://updates.example/healthz"),
    {} as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
});
