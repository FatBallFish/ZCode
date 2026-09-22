import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BRAND_ROOT = join(REPOSITORY_ROOT, "brand/mikiko");

function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

function alphaBounds(png, threshold = 8) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.data[(y * png.width + x) * 4 + 3];
      if (alpha <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return { minX, minY, maxX, maxY };
}

function assertTransparentSubject(path, expectedInsetRatio) {
  const png = readPng(path);
  assert.equal(png.width, png.height, `${path} must be square`);

  const corners = [
    [0, 0],
    [png.width - 1, 0],
    [0, png.height - 1],
    [png.width - 1, png.height - 1],
  ];
  for (const [x, y] of corners) {
    assert.equal(png.data[(y * png.width + x) * 4 + 3], 0, `${path} corner must be clear`);
  }

  const bounds = alphaBounds(png);
  const expectedInset = png.width * expectedInsetRatio;
  const tolerance = Math.max(2, png.width * 0.012);
  for (const [edge, actual] of [
    ["left", bounds.minX],
    ["top", bounds.minY],
    ["right", png.width - 1 - bounds.maxX],
    ["bottom", png.height - 1 - bounds.maxY],
  ]) {
    assert.ok(
      Math.abs(actual - expectedInset) <= tolerance,
      `${path} ${edge} inset ${actual} must be within ${tolerance.toFixed(1)}px of ${expectedInset.toFixed(1)}px`,
    );
  }

  // 新蒙版边缘必须落在深色主体上；若仍落在烘焙棋盘格上，会形成可见的浅色外圈。
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const alpha = png.data[offset + 3];
      if (alpha < 32) continue;
      const onOuterBand =
        x <= bounds.minX + 2 ||
        x >= bounds.maxX - 2 ||
        y <= bounds.minY + 2 ||
        y >= bounds.maxY - 2;
      if (!onOuterBand) continue;
      const luminance =
        png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
      assert.ok(luminance < 200, `${path} has a pale fringe at ${x},${y}`);
    }
  }
}

function readIcoPngEntries(path) {
  const ico = readFileSync(path);
  assert.equal(ico.readUInt16LE(0), 0, `${path} ICO reserved field`);
  assert.equal(ico.readUInt16LE(2), 1, `${path} ICO type`);
  const count = ico.readUInt16LE(4);

  return Array.from({ length: count }, (_, index) => {
    const directoryOffset = 6 + index * 16;
    const declaredWidth = ico.readUInt8(directoryOffset) || 256;
    const declaredHeight = ico.readUInt8(directoryOffset + 1) || 256;
    const byteLength = ico.readUInt32LE(directoryOffset + 8);
    const imageOffset = ico.readUInt32LE(directoryOffset + 12);
    const image = ico.subarray(imageOffset, imageOffset + byteLength);
    assert.deepEqual(
      [...image.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      `${path} entry ${index} must embed PNG`,
    );
    return { declaredWidth, declaredHeight, png: PNG.sync.read(image) };
  });
}

function assertSameFile(left, right) {
  assert.ok(
    readFileSync(left).equals(readFileSync(right)),
    `${right} must be generated from ${left}`,
  );
}

test("platform masters remove the baked background and use their platform safe areas", () => {
  assertTransparentSubject(join(BRAND_ROOT, "master-icon-1024.png"), 64 / 1024);
  assertTransparentSubject(join(BRAND_ROOT, "master-icon-macos-1024.png"), 100 / 1024);
});

test("Windows and Web ICO frames preserve transparent portable icon pixels", () => {
  const cases = [
    [join(BRAND_ROOT, "icon.ico"), [256, 128, 64, 48, 32, 16]],
    [join(BRAND_ROOT, "favicon.ico"), [32, 16]],
  ];

  for (const [path, expectedSizes] of cases) {
    const entries = readIcoPngEntries(path);
    assert.deepEqual(
      entries.map(({ declaredWidth }) => declaredWidth),
      expectedSizes,
      `${path} frame sizes`,
    );
    for (const { declaredWidth, declaredHeight, png } of entries) {
      assert.equal(png.width, declaredWidth);
      assert.equal(png.height, declaredHeight);
      const bounds = alphaBounds(png);
      assert.ok(bounds.minX > 0, `${path} ${png.width}px frame must have a transparent left inset`);
      assert.ok(bounds.minY > 0, `${path} ${png.width}px frame must have a transparent top inset`);
      assert.equal(png.data[3], 0, `${path} ${png.width}px top-left corner must be transparent`);
    }
  }
});

test("published desktop, Linux, public, and Web assets stay synchronized", () => {
  assertSameFile(
    join(BRAND_ROOT, "master-icon-1024.png"),
    join(REPOSITORY_ROOT, "packages/desktop/build/icon.png"),
  );
  assertSameFile(
    join(BRAND_ROOT, "master-icon-macos-1024.png"),
    join(REPOSITORY_ROOT, "packages/desktop/build/icon_macos.png"),
  );
  assertSameFile(join(BRAND_ROOT, "master-icon-macos-1024.png"), join(BRAND_ROOT, "dock-icon.png"));
  assertSameFile(
    join(BRAND_ROOT, "icon.icns"),
    join(REPOSITORY_ROOT, "packages/desktop/build/icon.icns"),
  );
  assertSameFile(
    join(BRAND_ROOT, "icon.ico"),
    join(REPOSITORY_ROOT, "packages/desktop/build/icon.ico"),
  );
  assertSameFile(
    join(BRAND_ROOT, "favicon.ico"),
    join(REPOSITORY_ROOT, "packages/web/public/favicon.ico"),
  );

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const brandPng = join(BRAND_ROOT, "png", `${size}x${size}.png`);
    assertSameFile(
      brandPng,
      join(REPOSITORY_ROOT, "packages/desktop/build/icons", `${size}x${size}.png`),
    );
    assertSameFile(brandPng, join(REPOSITORY_ROOT, "public/logo/icons", `${size}x${size}.png`));
  }
});

test("Web inline favicon is the generated favicon byte-for-byte", () => {
  const html = readFileSync(join(REPOSITORY_ROOT, "packages/web/index.html"), "utf8");
  const match = html.match(/href="data:image\/x-icon;base64,([^"]+)"/);
  assert.ok(match, "packages/web/index.html must contain the generated ICO data URL");
  assert.deepEqual(Buffer.from(match[1], "base64"), readFileSync(join(BRAND_ROOT, "favicon.ico")));
});

test("desktop runtime packages and selects the explicit macOS icon", () => {
  const mainSource = readFileSync(
    join(REPOSITORY_ROOT, "packages/desktop/src/main/index.ts"),
    "utf8",
  );
  const windowChromeSource = readFileSync(
    join(REPOSITORY_ROOT, "packages/desktop/src/main/desktopWindowChrome.ts"),
    "utf8",
  );
  const builderSource = readFileSync(
    join(REPOSITORY_ROOT, "packages/desktop/electron-builder.config.js"),
    "utf8",
  );

  assert.match(mainSource, /process\.platform === "darwin"[\s\S]{0,160}icon_macos\.png/);
  assert.match(builderSource, /from: "build\/icon_macos\.png"/);
  assert.doesNotMatch(windowChromeSource, /dock-icon\.png/);
});

test("asset build is idempotent when the inline favicon is already current", () => {
  const htmlPath = join(REPOSITORY_ROOT, "packages/web/index.html");
  const before = readFileSync(htmlPath);
  execFileSync(process.execPath, [join(BRAND_ROOT, "tools/build-new-icon.mjs")], {
    cwd: REPOSITORY_ROOT,
    stdio: "pipe",
  });
  assert.ok(before.equals(readFileSync(htmlPath)));
});
