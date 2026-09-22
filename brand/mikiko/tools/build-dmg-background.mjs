#!/usr/bin/env node
/* eslint-disable no-console */
// DMG 安装背景派生工具（specs/desktop/dmg-installer.md 唯一写入路径）。
// 产物：packages/desktop/build/dmg_background{,@2x}.png —— 白色为主体的极浅纵向渐变，
// 保证黑色应用图标与 Applications 文件夹别名在安装窗口中清晰可见。
// 不引入图片依赖：PNG 用 node:zlib 逐扫描线编码（filter 0、RGB 8bit），像素由参数确定性计算。

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outputs = [
  { file: resolve(repoRoot, "packages/desktop/build/dmg_background.png"), width: 540, height: 380 },
  {
    file: resolve(repoRoot, "packages/desktop/build/dmg_background@2x.png"),
    width: 1080,
    height: 760,
  },
];

// 顶部纯白，底部极浅暖灰；@2x 与 @1x 按归一化坐标保持完全一致的观感。
const gradientTop = [0xff, 0xff, 0xff];
const gradientBottom = [0xf2, 0xf2, 0xf4];

function crc32(bytes) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x / (width - 1), y / (height - 1));
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const { file, width, height } of outputs) {
  const png = encodePng(width, height, (_nx, ny) => [
    Math.round(gradientTop[0] + (gradientBottom[0] - gradientTop[0]) * ny),
    Math.round(gradientTop[1] + (gradientBottom[1] - gradientTop[1]) * ny),
    Math.round(gradientTop[2] + (gradientBottom[2] - gradientTop[2]) * ny),
  ]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  console.log(`[dmg-background] 写入 ${file} (${width}x${height}, ${png.length} bytes)`);
}
