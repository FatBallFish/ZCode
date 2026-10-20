/** 自建产品 HTTP 边界；账号专用代理与普通产品路由必须分别授权。 */
export { default as mikikoCloudWorker } from "./worker.js";
import worker from "./worker.js";
export type MikikoCloudBindings = Parameters<typeof worker.fetch>[1];
