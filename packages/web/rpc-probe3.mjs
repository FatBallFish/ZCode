import { connectViaWebSocket } from "@zcode/client";
const services = await connectViaWebSocket("ws://localhost:3030/ws", { onDisconnect: () => {} });
const usage = await services.sub2ApiService.getUsageSnapshot("mikikocc", "7d");
console.log(
  "usage points:",
  usage.points.length,
  "models:",
  usage.models.length,
  "totals:",
  JSON.stringify(usage.totals),
);
const detail = await services.sub2ApiService.getAccountDetail("mikikocc");
console.log(
  "subs:",
  detail.subscriptions.length,
  "groups:",
  detail.groups.length,
  "balance:",
  detail.account.balanceUsd,
);
const keys = await services.sub2ApiService.listKeys("mikikocc");
console.log(
  "keys:",
  keys.length,
  keys
    .slice(0, 3)
    .map((k) => `${k.name}(${k.groupLabel ?? "-"}${k.active ? "*" : ""})`)
    .join(", "),
);
process.exit(0);
