import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PET_MARKET_DEFAULT_RAW_BASE,
  buildPetMarketUrl,
  type MarketInstallManifest,
} from "@zcode/shared";
import {
  createPetMarketService,
  type PetMarketServiceDeps,
} from "../../src/main/desktopPetMarketService.js";

/**
 * 市场服务（specs/desktop/desktop-pet.md）：SHA-256 校验、暂存切换、force/额外文件拒绝、
 * Codex 只读导入、更新比对。fetch/尺寸读取全部注入，真实网络与 Electron 不参与。
 */

const SHEET_WIDTH = 1536;
const SHEET_HEIGHT_V1 = 1872;

function fakeWebpBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Harness {
  service: ReturnType<typeof createPetMarketService>;
  petRoot: string;
  codexRoot: string;
  downloads: Map<string, Uint8Array | string>;
  serve: (path: string, body: Uint8Array | string) => void;
  dispose: () => void;
}

function createHarness(options?: { manifestOverrides?: Record<string, unknown> }): Harness {
  const base = mkdtempSync(join(tmpdir(), "mikiko-pet-market-test-"));
  const petRoot = join(base, "pets");
  const codexRoot = join(base, "codex-pets");
  mkdirSync(petRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  const downloads = new Map<string, Uint8Array | string>();

  const petJson = new TextEncoder().encode(
    JSON.stringify({ id: "firefly--test", displayName: "流萤·测试" }),
  );
  const sheet = fakeWebpBytes();
  downloads.set(`pets/firefly--test/pet.json`, petJson);
  downloads.set(`pets/firefly--test/spritesheet.webp`, sheet);
  downloads.set(`pets/firefly--test/submission.json`, "{}");
  downloads.set(
    "pets.json",
    JSON.stringify([
      {
        slug: "firefly--test",
        name: "Firefly",
        localized_names: { zh: "流萤" },
        spriteVersionNumber: 1,
      },
    ]),
  );
  downloads.set("categories.json", JSON.stringify([{ slug: "game", name: "Game" }]));
  const manifest: MarketInstallManifest | Record<string, unknown> = {
    schemaVersion: 1,
    repository: "legeling/awesome-codex-pet",
    ref: "main",
    pets: {
      "firefly--test": {
        name: "Firefly",
        spriteVersionNumber: 1,
        petJsonSha256: sha256(petJson),
        petJsonBytes: petJson.byteLength,
        spritesheetSha256: sha256(sheet),
        spritesheetBytes: sheet.byteLength,
        spritesheetWidth: SHEET_WIDTH,
        spritesheetHeight: SHEET_HEIGHT_V1,
      },
    },
    ...(options?.manifestOverrides ?? {}),
  };
  downloads.set("install-manifest.json", JSON.stringify(manifest));

  const deps: PetMarketServiceDeps = {
    fetchText: async (url) => {
      const body = downloads.get(marketPathOf(url));
      if (typeof body !== "string") throw new Error(`missing text ${url}`);
      return body;
    },
    fetchBytes: async (url) => {
      const body = downloads.get(marketPathOf(url));
      if (!(body instanceof Uint8Array)) throw new Error(`missing bytes ${url}`);
      return body;
    },
    petRootDir: () => petRoot,
    codexPetsDirs: () => [codexRoot],
    readImageSize: () => ({ width: SHEET_WIDTH, height: SHEET_HEIGHT_V1 }),
  };
  return {
    service: createPetMarketService(deps),
    petRoot,
    codexRoot,
    downloads,
    serve: (path, body) => downloads.set(path, body),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  };
}

function marketPathOf(url: string): string {
  const prefix = `${PET_MARKET_DEFAULT_RAW_BASE}/`;
  if (!url.startsWith(prefix)) throw new Error(`unexpected url ${url}`);
  return url.slice(prefix.length);
}

test("安装：校验通过 → 暂存切换 → .install.json + 提交元数据落盘", async () => {
  const harness = createHarness();
  try {
    const result = await harness.service.install("firefly--test", false);
    assert.deepEqual(result, { ok: true });
    const petDir = join(harness.petRoot, "firefly--test");
    assert.ok(existsSync(join(petDir, "pet.json")));
    assert.ok(existsSync(join(petDir, "spritesheet.webp")));
    assert.ok(existsSync(join(petDir, "submission.json")));
    const record = JSON.parse(readFileSync(join(petDir, ".install.json"), "utf8")) as {
      installedFrom: string;
      spriteVersionNumber: number;
    };
    assert.equal(record.installedFrom, "market");
    assert.equal(record.spriteVersionNumber, 1);

    const installed = harness.service.listInstalled();
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.displayName, "流萤·测试");
    assert.equal(installed[0]!.spriteVersionNumber, 1);
    assert.equal(installed[0]!.updatable, false);
    // 暂存目录不残留。
    assert.deepEqual(
      readdirSync(harness.petRoot).filter(
        (name) => name.startsWith(".") && !name.includes("backup"),
      ),
      [],
    );
  } finally {
    harness.dispose();
  }
});

test("安装失败路径：SHA 不符拒绝且不留半成品；重复安装需 force", async () => {
  const harness = createHarness();
  try {
    const original = harness.downloads.get("pets/firefly--test/spritesheet.webp") as Uint8Array;
    const tampered = new Uint8Array(original);
    tampered[20] ^= 0xff;
    harness.serve("pets/firefly--test/spritesheet.webp", tampered);
    const rejected = await harness.service.install("firefly--test", false);
    assert.ok(!rejected.ok);
    assert.match(rejected.error ?? "", /checksum/);
    assert.deepEqual(readdirSync(harness.petRoot), []);

    harness.serve("pets/firefly--test/spritesheet.webp", original);
    assert.ok((await harness.service.install("firefly--test", false)).ok);
    const again = await harness.service.install("firefly--test", false);
    assert.ok(!again.ok);
    assert.match(again.error ?? "", /already installed/);
    assert.ok((await harness.service.install("firefly--test", true)).ok);
  } finally {
    harness.dispose();
  }
});

test("覆盖保护：目标目录含额外文件或符号链接时拒绝", async () => {
  const harness = createHarness();
  try {
    const petDir = join(harness.petRoot, "firefly--test");
    mkdirSync(petDir, { recursive: true });
    writeFileSync(join(petDir, "mystery.txt"), "x");
    const refused = await harness.service.install("firefly--test", true);
    assert.ok(!refused.ok);
    assert.match(refused.error ?? "", /unexpected entries/);

    rmSync(petDir, { recursive: true, force: true });
    mkdirSync(petDir, { recursive: true });
    const outside = join(harness.petRoot, "outside.webp");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(petDir, "spritesheet.webp"));
    const refusedLink = await harness.service.install("firefly--test", true);
    assert.ok(!refusedLink.ok);
  } finally {
    harness.dispose();
  }
});

test("更新比对：远端 SHA 变化后 listInstalled 标注 updatable，force 重装后清除", async () => {
  const harness = createHarness();
  try {
    assert.ok((await harness.service.install("firefly--test", false)).ok);
    // 模拟上游发版：远端 pet.json 内容与 manifest SHA 同步变化。
    const petJson = new TextEncoder().encode(
      JSON.stringify({ id: "firefly--test", displayName: "流萤·测试", description: "v2 文案" }),
    );
    harness.serve("pets/firefly--test/pet.json", petJson);
    const originalManifest = JSON.parse(
      String(harness.downloads.get("install-manifest.json")),
    ) as MarketInstallManifest;
    const sheetBytes = harness.downloads.get("pets/firefly--test/spritesheet.webp") as Uint8Array;
    harness.serve(
      "install-manifest.json",
      JSON.stringify({
        ...originalManifest,
        pets: {
          "firefly--test": {
            ...originalManifest.pets["firefly--test"]!,
            petJsonSha256: sha256(petJson),
            petJsonBytes: petJson.byteLength,
            spritesheetSha256: sha256(sheetBytes),
          },
        },
      }),
    );
    // 触发目录重拉（getCatalog refresh）。
    await harness.service.getCatalog({ refresh: true });
    const before = harness.service.listInstalled();
    assert.equal(before[0]!.updatable, true);
    assert.ok((await harness.service.install("firefly--test", true)).ok);
    const after = harness.service.listInstalled();
    assert.notEqual(after[0]!.updatable, true);
  } finally {
    harness.dispose();
  }
});

test("Codex 导入：合法包复制、源目录不动、已装跳过", () => {
  const harness = createHarness();
  try {
    const source = join(harness.codexRoot, "rem--l1");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "pet.json"), JSON.stringify({ id: "rem--l1", displayName: "蕾姆" }));
    writeFileSync(join(source, "spritesheet.webp"), fakeWebpBytes());
    const result = harness.service.importFromCodex();
    assert.deepEqual(result.imported, ["rem--l1"]);
    assert.ok(existsSync(join(harness.petRoot, "rem--l1", "pet.json")));
    assert.ok(existsSync(join(source, "pet.json")), "Codex 源目录必须保持只读");
    const record = JSON.parse(
      readFileSync(join(harness.petRoot, "rem--l1", ".install.json"), "utf8"),
    ) as { installedFrom: string };
    assert.equal(record.installedFrom, "codex-import");

    const again = harness.service.importFromCodex();
    assert.deepEqual(again.imported, []);
    assert.equal(again.skipped[0]?.reason, "already installed");
  } finally {
    harness.dispose();
  }
});

test("卸载：合法目录移除；未知 id 拒绝", async () => {
  const harness = createHarness();
  try {
    assert.ok((await harness.service.install("firefly--test", false)).ok);
    assert.ok(harness.service.uninstall("firefly--test").ok);
    assert.ok(!existsSync(join(harness.petRoot, "firefly--test")));
    assert.ok(!harness.service.uninstall("firefly--test").ok);
  } finally {
    harness.dispose();
  }
});
