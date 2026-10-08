import assert from "node:assert/strict";
import test from "node:test";
import {
  PET_FRAME_HEIGHT,
  PET_SPRITESHEET_WIDTH,
  PET_V1_SPRITESHEET_HEIGHT,
  PET_V2_SPRITESHEET_HEIGHT,
  buildPetMarketUrl,
  readWebpSize,
  normalizePetManifest,
  searchMarketPets,
  type MarketPetEntry,
  DEFAULT_PET_ANIMATIONS,
} from "@zcode/shared";

/**
 * 宠物包清单校验（specs/desktop/desktop-pet.md）：
 * v1/v2 网格推导、路径穿越拒绝、网格不一致拒绝、动作覆盖与越界校验、市场搜索与源 URL 构造。
 */

const SHEET_W = PET_SPRITESHEET_WIDTH;

test("缺省网格：v1/v2 高度推导行数，其余高度拒绝", () => {
  const v1 = normalizePetManifest({
    manifest: { id: "a", displayName: "A" },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(v1.ok);
  assert.equal(v1.pet.rows, 9);
  assert.equal(v1.pet.frameCount, 72);
  assert.equal(v1.pet.spritesheetPath, "spritesheet.webp");

  const v2 = normalizePetManifest({
    manifest: {},
    fallbackId: "b",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V2_SPRITESHEET_HEIGHT,
  });
  assert.ok(v2.ok);
  assert.equal(v2.pet.rows, 11);
  assert.equal(v2.pet.displayName, "b");

  const bad = normalizePetManifest({
    manifest: {},
    fallbackId: "c",
    sheetWidth: SHEET_W,
    sheetHeight: PET_FRAME_HEIGHT * 10,
  });
  assert.ok(!bad.ok);
});

// 2026-10-09 事故回归：上游市场 pet.json 新增 "kind": "character" 元数据键，
// strict 校验拒绝导致「DeepSeek 娘」安装失败（invalid pet.json: Unrecognized
// key: "kind"）。Codex 原版 serde 对未知字段静默忽略，三层 schema 改 loose 对齐；
// 已知字段类型不符仍须整体拒绝。
test("未知键容忍（含嵌套）；已知字段类型不符仍拒绝", () => {
  const upstream = normalizePetManifest({
    manifest: {
      id: "deepseek-girl--legeling",
      displayName: "DeepSeek Girl",
      description: "聪明亲切的蓝鲸少女",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
      kind: "character",
    },
    fallbackId: "deepseek-girl--legeling",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V2_SPRITESHEET_HEIGHT,
  });
  assert.ok(upstream.ok);
  assert.equal(upstream.pet.id, "deepseek-girl--legeling");

  const nestedUnknown = normalizePetManifest({
    manifest: {
      animations: { idle: { frames: [0, 1], flipX: true }, look: { frames: [72], unknown: 1 } },
      frame: { width: 192, height: 208, columns: 8, rows: 11, extra: "x" },
    },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V2_SPRITESHEET_HEIGHT,
  });
  assert.ok(nestedUnknown.ok);

  const badType = normalizePetManifest({
    manifest: { id: 123 },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(!badType.ok);
});

test("spritesheet 路径穿越/绝对路径拒绝；相对子路径放行", () => {
  for (const spritesheetPath of ["../x.webp", "/abs/x.webp", "C:\\x.webp", "a\\b.webp"]) {
    const result = normalizePetManifest({
      manifest: { spritesheetPath },
      fallbackId: "a",
      sheetWidth: SHEET_W,
      sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
    });
    assert.ok(!result.ok, spritesheetPath);
  }
  const ok = normalizePetManifest({
    manifest: { spritesheetPath: "assets/cat.webp" },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(ok.ok);
});

test("frame 覆盖必须恰好覆盖图集；帧数越界拒绝", () => {
  const mismatch = normalizePetManifest({
    manifest: { frame: { width: 100, height: 208, columns: 8, rows: 9 } },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(!mismatch.ok);
});

test("动作覆盖：fps/loop 生效、索引越界拒绝、fallback 缺失拒绝", () => {
  const override = normalizePetManifest({
    manifest: {
      id: "a",
      animations: {
        idle: { frames: [0, 1], fps: 10, loop: true },
      },
    },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(override.ok);
  assert.equal(override.pet.animations["idle"]!.frames.length, 2);
  assert.equal(override.pet.animations["idle"]!.frames[0]!.durationMs, 100);

  const oob = normalizePetManifest({
    manifest: { animations: { idle: { frames: [999] } } },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(!oob.ok);

  const missingFallback = normalizePetManifest({
    manifest: { animations: { idle: { frames: [0], fallback: "nope" } } },
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V1_SPRITESHEET_HEIGHT,
  });
  assert.ok(!missingFallback.ok);
});

test("缺省动作表覆盖九行 + v2 look 环视（16 帧往返）", () => {
  const v2 = normalizePetManifest({
    manifest: {},
    fallbackId: "a",
    sheetWidth: SHEET_W,
    sheetHeight: PET_V2_SPRITESHEET_HEIGHT,
  });
  assert.ok(v2.ok);
  for (const name of [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
  ]) {
    assert.ok(v2.pet.animations[name], name);
  }
  const look = v2.pet.animations["look"]!;
  // 顺时针 16 帧再逆序折返，共 32 帧；全部落在行 9/10。
  assert.equal(look.frames.length, 32);
  for (const frame of look.frames) {
    assert.ok(frame.spriteIndex >= 9 * 8 && frame.spriteIndex < 11 * 8);
  }
});

test("市场搜索：多关键词 AND、slug/双语名/标签命中", () => {
  const entries: MarketPetEntry[] = [
    {
      slug: "firefly--legeling",
      name: "Firefly",
      localized_names: { zh: "流萤" },
      tags: ["anime", "honkai-star-rail"],
    },
    { slug: "rem--l1", name: "Rem", localized_names: { zh: "蕾姆" }, tags: ["anime"] },
  ];
  assert.deepEqual(
    searchMarketPets(entries, "流萤").map((entry) => entry.slug),
    ["firefly--legeling"],
  );
  assert.deepEqual(
    searchMarketPets(entries, "firefly anime").map((entry) => entry.slug),
    ["firefly--legeling"],
  );
  assert.deepEqual(searchMarketPets(entries, "皮卡丘"), []);
  assert.deepEqual(searchMarketPets(entries, "  ").length, 2);
});

function webpContainer(chunkFourcc: string, chunkBody: Uint8Array): Uint8Array {
  const size = chunkBody.length;
  const bytes = new Uint8Array(12 + 8 + size + (size % 2));
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  const total = bytes.length - 8;
  bytes[4] = total & 0xff;
  bytes[5] = (total >> 8) & 0xff;
  bytes.set(
    [...chunkFourcc].map((c) => c.charCodeAt(0)),
    12,
  );
  bytes[16] = size & 0xff;
  bytes[17] = (size >> 8) & 0xff;
  bytes.set(chunkBody, 20);
  return bytes;
}

test("WebP 尺寸解析：VP8X/VP8/VP8L 三形态 + 坏头拒绝", () => {
  // VP8X：canvas 宽高各减一，24-bit LE。
  const vp8x = webpContainer("VP8X", new Uint8Array([0x10, 0, 0, 0, 0xff, 0x05, 0, 0x4f, 0x07, 0]));
  assert.deepEqual(readWebpSize(vp8x), { width: 0x5ff + 1, height: 0x74f + 1 });
  // VP8 lossy：sync 0x9d012a + u14 宽高。
  const vp8 = webpContainer(
    "VP8 ",
    new Uint8Array([0x30, 0x01, 0, 0x9d, 0x01, 0x2a, 0x00, 0x06, 0x30, 0x07]),
  );
  assert.deepEqual(readWebpSize(vp8), { width: 0x0600, height: 0x0730 });
  // VP8L：签名 0x2f + 14bit LE 位流（宽-1、高-1）。
  const vp8l = webpContainer("VP8L", new Uint8Array([0x2f, 0xff, 0x05, 0xcf, 0x08]));
  // bits = 0x08cf05ff：宽 = (bits & 0x3fff)+1 = 0x5ff+1；高 = ((bits>>14)&0x3fff)+1 = 0x232+1
  const bits = 0x08cf05ff;
  assert.deepEqual(readWebpSize(vp8l), {
    width: (bits & 0x3fff) + 1,
    height: ((bits >> 14) & 0x3fff) + 1,
  });
  assert.equal(readWebpSize(new Uint8Array([1, 2, 3])), null);
});

test("市场源 URL：仅无凭据 HTTPS；http/带查询拒绝", () => {
  assert.equal(
    buildPetMarketUrl("https://raw.example.com/base/", "pets.json"),
    "https://raw.example.com/base/pets.json",
  );
  assert.throws(() => buildPetMarketUrl("http://raw.example.com/", "pets.json"));
  assert.throws(() => buildPetMarketUrl("https://user:pass@example.com/", "pets.json"));
});

// —— 默认动作表与官方图集空格子对齐（闪烁回归）——
// 像素级实测（codex/dewey/fireball/rocky/nahida 官方与市场图集一致）：
// 每行末尾的空白格（idle 行第 6/7 格、waving 第 4 格起等）。默认动作若引用
// 空白格，桌面宠物与设置预览会周期性画到空帧——用户报告的「闪烁」。
const NON_BLANK_CELLS_PER_ROW = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const;

test("默认动作表不引用图集空白格（闪烁回归）", () => {
  for (const [name, animation] of Object.entries(DEFAULT_PET_ANIMATIONS)) {
    for (const frame of animation.frames) {
      const row = Math.floor(frame.spriteIndex / 8);
      const col = frame.spriteIndex % 8;
      assert.ok(
        col < NON_BLANK_CELLS_PER_ROW[row],
        `${name} 引用第 ${row} 行第 ${col} 格，该格在官方图集中为空白（闪烁根因）`,
      );
    }
  }
});

test("idle 默认表逐帧对齐官方 idle_animation（6 帧呼吸节奏）", () => {
  assert.deepEqual(
    DEFAULT_PET_ANIMATIONS.idle.frames.map((f) => [f.spriteIndex, f.durationMs]),
    [
      [0, 1680],
      [1, 660],
      [2, 660],
      [3, 840],
      [4, 840],
      [5, 1920],
    ],
  );
  assert.equal(DEFAULT_PET_ANIMATIONS.idle.loop, true);
});

test("一次性动作主序列×3 后回落 idle（官方 app_state_animation 语义）", () => {
  const waving = DEFAULT_PET_ANIMATIONS.waving.frames;
  assert.equal(waving.length, 12, "waving 4 帧 ×3");
  assert.deepEqual(
    waving.map((f) => f.spriteIndex),
    Array.from({ length: 3 }, () => [24, 25, 26, 27]).flat(),
  );
  assert.equal(DEFAULT_PET_ANIMATIONS.waving.loop, false);
  assert.equal(DEFAULT_PET_ANIMATIONS.jumping.frames.length, 15, "jumping 5 帧 ×3");
});

test("官方别名 bounce/sad 与 jumping/failed 同行可用", () => {
  assert.equal(DEFAULT_PET_ANIMATIONS.bounce.frames[0]?.spriteIndex, 32);
  assert.equal(DEFAULT_PET_ANIMATIONS.sad.frames[0]?.spriteIndex, 40);
});

test("v1 图集剔除越界 look；v2 保留（播到图集外=宠物消失闪烁）", () => {
  const v1 = normalizePetManifest({
    manifest: { id: "v1pet" },
    fallbackId: "v1pet",
    sheetWidth: 1536,
    sheetHeight: 1872,
  });
  assert.ok(v1.ok);
  assert.equal(v1.pet.animations["look"], undefined, "v1（72 帧）没有第 9–10 行，look 必须剔除");
  for (const [name, animation] of Object.entries(v1.pet.animations)) {
    for (const frame of animation.frames) {
      assert.ok(frame.spriteIndex < 72, `${name} 索引 ${frame.spriteIndex} 越界（v1 共 72 帧）`);
    }
  }
  const v2 = normalizePetManifest({
    manifest: { id: "v2pet" },
    fallbackId: "v2pet",
    sheetWidth: 1536,
    sheetHeight: 2288,
  });
  assert.ok(v2.ok);
  assert.ok(v2.pet.animations["look"], "v2（88 帧）保留 look");
});
