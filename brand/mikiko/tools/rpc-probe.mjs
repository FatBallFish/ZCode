// RPC 探针：从 Node 连本地 dev server，验证服务握手与 Sub2Api 调用。
import { connectViaWebSocket } from "@zcode/client";

const services = await connectViaWebSocket("ws://localhost:3030/ws", {
  onDisconnect: () => {},
});
console.log("connected:", Boolean(services));
const state = await services.sub2ApiService.getState();
console.log("sub2api state:", JSON.stringify(state));
const info = await fetch("http://localhost:3030/api/server-info").then((r) => r.json());
console.log("server-info ok:", info.version);
process.exit(0);
