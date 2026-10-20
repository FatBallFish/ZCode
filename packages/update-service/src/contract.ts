/** The Worker remains the single HTTP router; bindings and release rules stay in its implementation. */
export { default as mikikoUpdateHttpWorker } from "./worker.js";
import worker from "./worker.js";
export type MikikoUpdateBindings = Parameters<typeof worker.fetch>[1];
