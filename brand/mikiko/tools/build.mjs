#!/usr/bin/env node
// Mikiko 资产构建流水线（macOS 原生工具链，无第三方依赖）：
//   raw/mark-geometric-1.png（Qwen 母图）
//     → 1024 圆角透明母版（SVG clipPath + qlmanage 光栅化，rx≈22.5%）
//     → PNG 全尺寸阶梯 + macOS .icns（iconutil）+ Windows .ico（内嵌 PNG 的 ICO 打包器）
//     → favicon.ico（32/16）与 base64
//   raw/dmg-bg-1.png → dmg_background.png(540x380) 与 @2x(1080x760)
// 用法：node build.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "raw");
const TMP = "/tmp/mikiko-build";
const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

mkdirSync(TMP, { recursive: true });
mkdirSync(join(ROOT, "png"), { recursive: true });

// 1) 圆角透明母版
const masterB64 = readFileSync(join(RAW, "mark-geometric-1.png")).toString("base64");
const clipSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><clipPath id="r"><rect width="1024" height="1024" rx="230"/></clipPath></defs><image width="1024" height="1024" clip-path="url(#r)" href="data:image/png;base64,${masterB64}" xlink:href="data:image/png;base64,${masterB64}"/></svg>`;
writeFileSync(join(TMP, "clip.svg"), clipSvg);
run(`qlmanage -t -s 1024 -o ${TMP} ${TMP}/clip.svg >/dev/null 2>&1`);
cpSync(join(TMP, "clip.svg.png"), join(ROOT, "master-icon-1024.png"));
console.log("master-icon-1024.png ✓");

// 2) PNG 尺寸阶梯
for (const s of [512, 256, 128, 64, 48, 32, 16]) {
  run(
    `sips -z ${s} ${s} ${join(ROOT, "master-icon-1024.png")} --out ${join(ROOT, "png", `${s}x${s}.png`)} >/dev/null`,
  );
}
console.log("png ladder ✓ (512/256/128/64/48/32/16)");

// 3) macOS .icns
const iconset = join(TMP, "Mikiko.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const s of [16, 32, 128, 256, 512]) {
  run(
    `sips -z ${s} ${s} ${join(ROOT, "master-icon-1024.png")} --out ${join(iconset, `icon_${s}x${s}.png`)} >/dev/null`,
  );
  run(
    `sips -z ${s * 2} ${s * 2} ${join(ROOT, "master-icon-1024.png")} --out ${join(iconset, `icon_${s}x${s}@2x.png`)} >/dev/null`,
  );
}
run(`iconutil -c icns ${iconset} -o ${join(ROOT, "icon.icns")}`);
console.log("icon.icns ✓");

// 4) ICO 打包器：Vista+ 的 PNG 内嵌格式
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  entries.forEach(([size, buf], i) => {
    dir.writeUInt8(size >= 256 ? 0 : size, i * 16 + 0);
    dir.writeUInt8(size >= 256 ? 0 : size, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4); // planes
    dir.writeUInt16LE(32, i * 16 + 6); // bitcount
    dir.writeUInt32LE(buf.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += buf.length;
    blobs.push(buf);
  });
  return Buffer.concat([header, dir, ...blobs]);
}
const pngBuf = (s) => readFileSync(join(ROOT, "png", `${s}x${s}.png`));
writeFileSync(
  join(ROOT, "icon.ico"),
  buildIco([256, 128, 64, 48, 32, 16].map((s) => [s, pngBuf(s)])),
);
writeFileSync(
  join(ROOT, "favicon.ico"),
  buildIco([
    [32, pngBuf(32)],
    [16, pngBuf(16)],
  ]),
);
writeFileSync(
  join(ROOT, "favicon-ico-base64.txt"),
  readFileSync(join(ROOT, "favicon.ico")).toString("base64"),
);
console.log("icon.ico / favicon.ico / favicon-ico-base64.txt ✓");

// 5) DMG 背景（现有安装包背景为 540x380，@2x 为 1080x760）
run(
  `sips -z 380 540 ${join(RAW, "dmg-bg-1.png")} --out ${join(ROOT, "dmg_background.png")} >/dev/null`,
);
cpSync(join(RAW, "dmg-bg-1.png"), join(ROOT, "dmg_background@2x.png"));
console.log("dmg_background(.@2x).png ✓");

console.log("\n全部产物位于 brand/mikiko/：");
console.log("  master-icon-1024.png / icon.icns / icon.ico / favicon.ico");
console.log("  png/{16..512}x{16..512}.png / dmg_background(@2x).png");
console.log("  mark.svg / wordmark.svg / lockup.svg（手工设计源）");
