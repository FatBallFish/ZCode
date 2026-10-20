import { pdfJsCMapsPlugin } from "./contract.js";
/** Vite accepts nested Plugin arrays and selects build versus serve without changing the URL contract. */
export function localPdfAssets() {
  return pdfJsCMapsPlugin();
}
