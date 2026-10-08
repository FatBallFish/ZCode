#!/usr/bin/env node
/**
 * 桌宠图集尺寸校验（specs/desktop/desktop-pet.md，随 create-pet skill 分发）。
 *
 * 无第三方依赖：直接读 PNG（IHDR）/ JPEG（SOF marker）/ WebP（VP8X/VP8/VP8L）头部
 * 解析画布尺寸（WebP 逻辑与 packages/shared/src/petWebp.ts 同款）。仅当尺寸恰好为
 * v1 1536×1872 或 v2 1536×2288 时退出码 0，否则 1——应用加载侧会拒绝其它尺寸。
 *
 * 用法：node verify-sheet.mjs <spritesheet 文件>
 */
import { readFile } from "node:fs/promises";

const V1 = { width: 1536, height: 1872, columns: 8, rows: 9 };
const V2 = { width: 1536, height: 2288, columns: 8, rows: 11 };
const CELL = { width: 192, height: 208 };

const target = process.argv[2];
if (!target) {
  console.error("usage: node verify-sheet.mjs <spritesheet file>");
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(target));
const size = readImageSize(bytes);
if (!size) {
  console.error(`✗ 无法解析图片尺寸（支持 PNG / JPEG / WebP）：${target}`);
  process.exit(1);
}

const match =
  size.width === V1.width && size.height === V1.height
    ? V1
    : size.width === V2.width && size.height === V2.height
      ? V2
      : null;

console.log(`文件: ${target}`);
console.log(`尺寸: ${size.width}×${size.height}`);
if (!match) {
  console.error(
    `✗ 尺寸不符：需要 v1 ${V1.width}×${V1.height} 或 v2 ${V2.width}×${V2.height}（${CELL.width}×${CELL.height} 帧 × 8 列）。` +
      `请按保持宽比的方式缩放/裁剪后重试。`,
  );
  process.exit(1);
}
console.log(
  `✓ ${match === V1 ? "v1" : "v2"} 图集：8 列 × ${match.rows} 行，帧 ${CELL.width}×${CELL.height}，共 ${match.columns * match.rows} 格。`,
);
console.log(
  "提醒：pet.json 的 spriteVersionNumber 仅 v2 需要写 2；文件安装前须转成 WebP 并命名 spritesheet.webp。",
);
process.exit(0);

function readImageSize(data) {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    // PNG：IHDR 固定在第 8 字节起，宽高各 u32 BE。
    return {
      width: (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19],
      height: (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23],
    };
  }
  if (readWebpSize(data)) return readWebpSize(data);
  return readJpegSize(data);
}

function readWebpSize(data) {
  const isWebp =
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50;
  if (!isWebp) return null;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const fourcc = String.fromCharCode(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      data[offset + 3],
    );
    const chunkSize =
      data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24);
    const body = offset + 8;
    if (fourcc === "VP8X") {
      if (body + 10 > data.length) return null;
      return {
        width: (data[body + 4] | (data[body + 5] << 8) | (data[body + 6] << 16)) + 1,
        height: (data[body + 7] | (data[body + 8] << 8) | (data[body + 9] << 16)) + 1,
      };
    }
    if (fourcc === "VP8 ") {
      if (body + 10 > data.length) return null;
      if (data[body + 3] !== 0x9d || data[body + 4] !== 0x01 || data[body + 5] !== 0x2a) return null;
      return {
        width: (data[body + 6] | (data[body + 7] << 8)) & 0x3fff,
        height: (data[body + 8] | (data[body + 9] << 8)) & 0x3fff,
      };
    }
    if (fourcc === "VP8L") {
      if (body + 5 > data.length || data[body] !== 0x2f) return null;
      const bits =
        data[body + 1] | (data[body + 2] << 8) | (data[body + 3] << 16) | (data[body + 4] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  return null;
}

function readJpegSize(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    // SOF0–SOF15（除 DHT/JPG/DAC）：段长 u16 BE，高在前。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (data[offset + 5] << 8) | data[offset + 6],
        width: (data[offset + 7] << 8) | data[offset + 8],
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = (data[offset + 2] << 8) | data[offset + 3];
    offset += 2 + segmentLength;
  }
  return null;
}
