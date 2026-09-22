#!/usr/bin/env node
// 修复图标四角白边：Qwen 原图的圆角方形外缘有浅色区域，与其圆角半径不一致。
// 处理：中心内缩裁切（切掉 AI 边缘瑕疵）→ 放大回 1024 → 重新圆角透明裁切。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "raw/mark-geometric-1.png");
const TMP = "/tmp/mikiko-iconfix";
const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });

mkdirSync(TMP, { recursive: true });

// 1) 中心内缩 9%（每边 ~46px，1024 → 932）切掉 AI 边缘白弧
run(`sips -c 932 932 ${RAW} --out ${TMP}/inset.png >/dev/null`);
// 2) 放大回 1024
run(`sips -z 1024 1024 ${TMP}/inset.png --out ${TMP}/scaled.png >/dev/null`);
// 3) 圆角透明裁切（rx=230 ≈ 22.5%）
const b64 = readFileSync(`${TMP}/scaled.png`).toString("base64");
const clipSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><clipPath id="r"><rect width="1024" height="1024" rx="230"/></clipPath></defs><image width="1024" height="1024" clip-path="url(#r)" href="data:image/png;base64,${b64}" xlink:href="data:image/png;base64,${b64}"/></svg>`;
writeFileSync(`${TMP}/clip.svg`, clipSvg);
run(`qlmanage -t -s 1024 -o ${TMP} ${TMP}/clip.svg >/dev/null 2>&1`);
cpSync(`${TMP}/clip.svg.png`, join(ROOT, "master-icon-1024.png"));
console.log("master-icon-1024.png rebuilt (inset 9% + rounded)");
