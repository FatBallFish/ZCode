// RPC 探针 v2：验证 sub2api 服务 v2 接口（getSites/getPublicSettings）。
import { connectViaWebSocket } from "@zcode/client";

const services = await connectViaWebSocket("ws://localhost:3030/ws", {
  onDisconnect: () => {},
});
const sites = await services.sub2ApiService.getSites();
console.log("sites:", JSON.stringify(sites).slice(0, 300));
const settings = await services.sub2ApiService.getPublicSettings("mikikocc");
console.log("publicSettings:", JSON.stringify(settings));
process.exit(0);
