#!/usr/bin/env node
// 从带烘焙棋盘格的 1024px RGB 原图中提取主体，并生成各平台唯一发布资产。
// macOS 使用 824px 安全区；Windows/Linux/Web 使用 896px 安全区。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(ROOT, "../..");
const SOURCE = join(ROOT, "new-icon/master-1024.png");
const PORTABLE_MASTER = join(ROOT, "master-icon-1024.png");
const MACOS_MASTER = join(ROOT, "master-icon-macos-1024.png");
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SOURCE_SUBJECT = { x: 109, y: 75, width: 806, height: 807, radius: 188 };
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "mikiko-icon-build-"));

function run(command, args) {
  execFileSync(command, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function assertSourceDimensions() {
  const source = readFileSync(SOURCE);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!source.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`图标输入不是 PNG: ${SOURCE}`);
  }
  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  if (width !== 1024 || height !== 1024) {
    throw new Error(`图标输入必须是 1024x1024，实际为 ${width}x${height}`);
  }
}

function renderMaster(outputPath, subjectSize) {
  const inset = (1024 - subjectSize) / 2;
  const radius = Math.round((SOURCE_SUBJECT.radius / SOURCE_SUBJECT.width) * subjectSize);
  const source = PNG.sync.read(readFileSync(SOURCE));
  const output = new PNG({ width: 1024, height: 1024, colorType: 6 });

  function sampleSource(x, y, channel) {
    const x0 = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
    const x1 = Math.min(source.width - 1, x0 + 1);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const xMix = x - Math.floor(x);
    const yMix = y - Math.floor(y);
    const top =
      source.data[(y0 * source.width + x0) * 4 + channel] * (1 - xMix) +
      source.data[(y0 * source.width + x1) * 4 + channel] * xMix;
    const bottom =
      source.data[(y1 * source.width + x0) * 4 + channel] * (1 - xMix) +
      source.data[(y1 * source.width + x1) * 4 + channel] * xMix;
    return Math.round(top * (1 - yMix) + bottom * yMix);
  }

  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const offset = (y * output.width + x) * 4;
      const half = subjectSize / 2;
      const relativeX = Math.abs(x + 0.5 - 512) - (half - radius);
      const relativeY = Math.abs(y + 0.5 - 512) - (half - radius);
      const outsideDistance =
        Math.hypot(Math.max(relativeX, 0), Math.max(relativeY, 0)) +
        Math.min(Math.max(relativeX, relativeY), 0) -
        radius;
      const alpha = Math.round(Math.max(0, Math.min(1, 0.5 - outsideDistance)) * 255);
      if (alpha === 0) continue;

      const sourceX =
        SOURCE_SUBJECT.x + ((x + 0.5 - inset) / subjectSize) * SOURCE_SUBJECT.width - 0.5;
      const sourceY =
        SOURCE_SUBJECT.y + ((y + 0.5 - inset) / subjectSize) * SOURCE_SUBJECT.height - 0.5;
      output.data[offset] = sampleSource(sourceX, sourceY, 0);
      output.data[offset + 1] = sampleSource(sourceX, sourceY, 1);
      output.data[offset + 2] = sampleSource(sourceX, sourceY, 2);
      output.data[offset + 3] = alpha;
    }
  }

  writeFileSync(outputPath, PNG.sync.write(output, { colorType: 6 }));
}

function resizePng(inputPath, outputPath, size) {
  run("sips", ["-z", String(size), String(size), inputPath, "--out", outputPath]);
}

function buildIco(sizes) {
  const entries = sizes.map((size) => [
    size,
    readFileSync(join(ROOT, "png", `${size}x${size}.png`)),
  ]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let imageOffset = 6 + directory.length;
  const images = [];

  entries.forEach(([size, image], index) => {
    const offset = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, offset);
    directory.writeUInt8(size >= 256 ? 0 : size, offset + 1);
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(image.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += image.length;
    images.push(image);
  });

  return Buffer.concat([header, directory, ...images]);
}

function syncFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function updateInlineFavicon(favicon) {
  const htmlPath = join(REPOSITORY_ROOT, "packages/web/index.html");
  const html = readFileSync(htmlPath, "utf8");
  const dataUrl = `data:image/x-icon;base64,${favicon.toString("base64")}`;
  const inlineFaviconPattern = /data:image\/x-icon;base64,[^"]+/;
  if (!inlineFaviconPattern.test(html)) {
    throw new Error(`未找到 Web 内嵌 favicon: ${htmlPath}`);
  }
  const updated = html.replace(inlineFaviconPattern, dataUrl);
  if (updated !== html) writeFileSync(htmlPath, updated);
}

try {
  assertSourceDimensions();
  mkdirSync(join(ROOT, "png"), { recursive: true });
  mkdirSync(join(ROOT, "linux-hicolor"), { recursive: true });

  // 原图的棋盘格和阴影都在主体圆角矩形之外；重新裁切并生成 alpha，避免颜色阈值留下白边。
  renderMaster(PORTABLE_MASTER, 896);
  renderMaster(MACOS_MASTER, 824);

  for (const size of PNG_SIZES) {
    resizePng(PORTABLE_MASTER, join(ROOT, "png", `${size}x${size}.png`), size);
  }

  const iconset = join(TEMP_ROOT, "Mikiko.iconset");
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    resizePng(MACOS_MASTER, join(iconset, `icon_${size}x${size}.png`), size);
    resizePng(MACOS_MASTER, join(iconset, `icon_${size}x${size}@2x.png`), size * 2);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", join(ROOT, "icon.icns")]);

  const windowsIco = buildIco([256, 128, 64, 48, 32, 16]);
  const faviconIco = buildIco([32, 16]);
  writeFileSync(join(ROOT, "icon.ico"), windowsIco);
  writeFileSync(join(ROOT, "favicon.ico"), faviconIco);
  writeFileSync(join(ROOT, "favicon-ico-base64.txt"), faviconIco.toString("base64"));

  syncFile(join(ROOT, "icon.icns"), join(ROOT, "icon_installer.icns"));
  syncFile(join(ROOT, "icon.ico"), join(ROOT, "icon_installer.ico"));
  syncFile(join(ROOT, "png/512x512.png"), join(ROOT, "icon_installer.png"));
  syncFile(MACOS_MASTER, join(ROOT, "dock-icon.png"));
  syncFile(PORTABLE_MASTER, join(ROOT, "icon_windows.png"));
  syncFile(PORTABLE_MASTER, join(ROOT, "icon_512@2x.png"));
  for (const size of PNG_SIZES) {
    syncFile(
      join(ROOT, "png", `${size}x${size}.png`),
      join(ROOT, "linux-hicolor", `${size}x${size}.png`),
    );
  }

  const desktopBuild = join(REPOSITORY_ROOT, "packages/desktop/build");
  syncFile(PORTABLE_MASTER, join(desktopBuild, "icon.png"));
  syncFile(MACOS_MASTER, join(desktopBuild, "icon_macos.png"));
  syncFile(join(ROOT, "icon.icns"), join(desktopBuild, "icon.icns"));
  syncFile(join(ROOT, "icon.ico"), join(desktopBuild, "icon.ico"));
  syncFile(join(ROOT, "icon_installer.icns"), join(desktopBuild, "icon_installer.icns"));
  syncFile(join(ROOT, "icon_installer.ico"), join(desktopBuild, "icon_installer.ico"));
  syncFile(join(ROOT, "icon_installer.png"), join(desktopBuild, "icon_installer.png"));
  syncFile(join(ROOT, "icon_windows.png"), join(desktopBuild, "icon_windows.png"));

  const publicIcons = join(REPOSITORY_ROOT, "public/logo/icons");
  for (const size of PNG_SIZES) {
    const source = join(ROOT, "png", `${size}x${size}.png`);
    syncFile(source, join(desktopBuild, "icons", `${size}x${size}.png`));
    syncFile(source, join(publicIcons, `${size}x${size}.png`));
  }
  syncFile(join(ROOT, "icon.icns"), join(publicIcons, "icon.icns"));
  syncFile(join(ROOT, "icon.ico"), join(publicIcons, "icon.ico"));
  syncFile(PORTABLE_MASTER, join(REPOSITORY_ROOT, "public/icon_512@2x.png"));
  syncFile(join(ROOT, "favicon.ico"), join(REPOSITORY_ROOT, "packages/web/public/favicon.ico"));
  updateInlineFavicon(faviconIco);

  console.log("Mikiko icon assets rebuilt and synchronized.");
} finally {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
}
