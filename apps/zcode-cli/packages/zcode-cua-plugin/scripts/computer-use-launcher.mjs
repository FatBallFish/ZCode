// 正常生产装配会直接绑定随包gateway；显式本地插件入口也只接受同一资源合同。
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
const server = process.env.MIKIKO_COMPUTER_USE_SERVER?.trim();
if (!server || !isAbsolute(server)) throw new Error("Mikiko Computer Use is not included in this runtime.");
await access(server);
process.argv[1] = server;
await import(pathToFileURL(server).href);
