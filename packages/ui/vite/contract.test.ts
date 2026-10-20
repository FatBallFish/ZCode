import { expect, it } from "vitest";
import { listPdfJsCMapAssets } from "./contract.js";
it("publishes only normalized nonempty packed CMap assets under the local resource directory", async () => {
  const assets = await listPdfJsCMapAssets();
  for (const asset of assets) {
    expect(asset.fileName).toMatch(/^pdfjs\/cmaps\/[^/\\]+\.bcmap$/);
    expect(asset.source.byteLength).toBeGreaterThan(0);
  }
});
