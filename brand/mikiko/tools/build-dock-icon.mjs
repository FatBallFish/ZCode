// 保留旧入口兼容性；实际安全区与透明蒙版由主流水线唯一生成。
import { copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "master-icon-macos-1024.png");
const OUTPUT = join(ROOT, "dock-icon.png");

copyFileSync(SOURCE, OUTPUT);
console.log("dock-icon.png copied from master-icon-macos-1024.png");
