import { mikikoCloudWorker, type MikikoCloudBindings } from "./contract.js";
/** 部署由 wrangler 负责；本调用仅展示请求与绑定注入，不替换路由 owner。 */
export function serveMikikoRequest(
  request: Request,
  bindings: MikikoCloudBindings,
): Promise<Response> {
  return mikikoCloudWorker.fetch(request, bindings);
}
