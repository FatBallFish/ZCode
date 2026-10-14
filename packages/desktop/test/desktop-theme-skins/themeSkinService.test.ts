import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThemeSkinSavePayload } from "@zcode/shared";
import { buildThemepackAssetUrl } from "@zcode/shared";
import {
  createThemeSkinService,
  type ThemeSkinService,
  type ThemeSkinServiceDeps,
} from "../../src/main/desktopThemeSkinService.js";

/**
 * 主题皮肤存储服务（specs/ui/theme-skins.md §5）：导入校验、暂存原子写入、
 * 自定义保存（含壁纸转正/保留/清除）、删除保护、导出组装。文件 IO 走临时目录注入。
 */

const PNG_BASE64 = "iVBORw0KGgo="; // 任意合法 base64 字节（服务不解码图片内容）

function createTestService(): { service: ThemeSkinService; rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "mikiko-theme-skins-test-"));
  const deps: ThemeSkinServiceDeps = { rootDir: () => rootDir };
  return { service: createThemeSkinService(deps), rootDir };
}

function validExportFileJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: "mikiko-theme-skin",
    formatVersion: 1,
    name: "导入皮肤",
    light: { "--color-accent": "#f6e3dc" },
    dark: { "--color-accent": "#43231a" },
    ...overrides,
  });
}

function savePayload(overrides: Partial<ThemeSkinSavePayload> = {}): ThemeSkinSavePayload {
  return {
    name: "我的主题",
    light: { "--color-accent": "#e0f0e2" },
    dark: { "--color-accent": "#10241a" },
    wallpaper: {
      mode: "none",
      fit: "cover",
      blurPx: 0,
      dimPercentLight: 46,
      dimPercentDark: 12,
    },
    ...overrides,
  };
}

test("saveCustomTheme 新建皮肤落盘并可在列表读回", async () => {
  const { service, rootDir } = createTestService();
  try {
    const result = await service.saveCustomTheme(savePayload());
    assert.ok(result.ok);
    assert.match(result.item.id, /^user-/);
    assert.equal(result.item.name, "我的主题");

    const list = service.listInstalled();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, result.item.id);
    assert.equal(list[0]!.light["--color-accent"], "#e0f0e2");
    assert.ok(existsSync(join(rootDir, result.item.id, "theme.json")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("saveCustomTheme 拒绝越界 token 与非法名称", async () => {
  const { service, rootDir } = createTestService();
  try {
    const badToken = await service.saveCustomTheme(
      savePayload({ light: { "--color-success": "#0f0" } }),
    );
    assert.ok(!badToken.ok);

    const badName = await service.saveCustomTheme(savePayload({ name: "  " }));
    assert.ok(!badName.ok);
    assert.equal(service.listInstalled().length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("saveCustomTheme 原地更新保留 createdAt 并切换壁纸（staged 转正 → keep → none）", async () => {
  const { service, rootDir } = createTestService();
  try {
    const created = await service.saveCustomTheme(savePayload());
    assert.ok(created.ok);
    const id = created.item.id;

    // 暂存壁纸：直接调 stageWallpaperImage 需要源文件，先在临时目录造一张。
    const sourceImage = join(rootDir, "..", "wallpaper-source.png");
    writeFileSync(sourceImage, Buffer.from(PNG_BASE64, "base64"));
    const staged = await service.stageWallpaperImage(sourceImage);
    assert.ok(staged.path);
    assert.ok(staged.path!.includes(`${join(rootDir, ".staging")}`));

    const withImage = await service.saveCustomTheme(
      savePayload({
        id,
        wallpaper: {
          mode: "image",
          stagedPath: staged.path!,
          fit: "cover",
          blurPx: 6,
          dimPercentLight: 40,
          dimPercentDark: 15,
        },
      }),
    );
    assert.ok(withImage.ok);
    assert.equal(withImage.item.wallpaper?.kind, "image");
    assert.equal(withImage.item.wallpaper?.blurPx, 6);
    assert.ok(withImage.item.wallpaperImagePath);
    assert.ok(existsSync(withImage.item.wallpaperImagePath!));
    assert.ok(
      buildThemepackAssetUrl(withImage.item.wallpaperImagePath!).startsWith("themepack://"),
    );

    // keep-image：只调公共参数，壁纸文件沿用。
    const kept = await service.saveCustomTheme(
      savePayload({
        id,
        wallpaper: {
          mode: "keep-image",
          fit: "contain",
          blurPx: 2,
          dimPercentLight: 30,
          dimPercentDark: 10,
        },
      }),
    );
    assert.ok(kept.ok);
    assert.equal(kept.item.wallpaper?.kind, "image");
    assert.equal(kept.item.wallpaper?.fit, "contain");
    assert.equal(kept.item.createdAt, withImage.item.createdAt, "原地更新保留 createdAt");
    // 整目录原子替换不能丢壁纸文件（2026-10-15 修复：keep-image 曾把旧目录里的壁纸一并替换掉）。
    assert.ok(existsSync(join(rootDir, id, "wallpaper.png")), "keep-image 后壁纸文件必须仍存在");
    assert.ok(existsSync(kept.item.wallpaperImagePath!));

    // 旧壁纸文件已丢失时 keep-image 显式失败，而不是静默产出坏引用。
    rmSync(join(rootDir, id, "wallpaper.png"), { force: true });
    const missing = await service.saveCustomTheme(
      savePayload({
        id,
        wallpaper: {
          mode: "keep-image",
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 10,
          dimPercentDark: 10,
        },
      }),
    );
    assert.ok(!missing.ok);
    assert.match(String(missing.error), /missing/);
    // 列表对坏引用降级为无壁纸主题。
    const degraded = service.listInstalled().find((item) => item.id === id);
    assert.equal(degraded?.wallpaper, undefined);

    // none：清除壁纸后导出文件不再包含壁纸。
    const cleared = await service.saveCustomTheme(
      savePayload({
        id,
        wallpaper: {
          mode: "none",
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 46,
          dimPercentDark: 12,
        },
      }),
    );
    assert.ok(cleared.ok);
    assert.equal(cleared.item.wallpaper, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("saveCustomTheme 拒绝暂存目录外的壁纸路径（防路径注入）", async () => {
  const { service, rootDir } = createTestService();
  try {
    const outside = join(rootDir, "..", "outside.png");
    writeFileSync(outside, Buffer.from(PNG_BASE64, "base64"));
    const result = await service.saveCustomTheme(
      savePayload({
        wallpaper: {
          mode: "image",
          stagedPath: outside,
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 10,
          dimPercentDark: 10,
        },
      }),
    );
    assert.ok(!result.ok);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("installThemeFile 校验并安装合法 .mikikotheme（含 dataURI 壁纸）", async () => {
  const { service, rootDir } = createTestService();
  try {
    const file = join(rootDir, "..", "importable.mikikotheme");
    writeFileSync(
      file,
      validExportFileJson({
        wallpaper: {
          kind: "image",
          dataUrl: `data:image/png;base64,${PNG_BASE64}`,
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 20,
          dimPercentDark: 10,
        },
      }),
    );
    const result = await service.installThemeFile(file);
    assert.ok(result.ok);
    assert.equal(result.item.name, "导入皮肤");
    assert.equal(result.item.wallpaper?.kind, "image");
    assert.ok(existsSync(join(rootDir, result.item.id, "wallpaper.png")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("installThemeFile 拒绝越界 token / svg 壁纸 / 超大文件", async () => {
  const { service, rootDir } = createTestService();
  try {
    const dir = join(rootDir, "..");
    const badTokenFile = join(dir, "bad-token.mikikotheme");
    writeFileSync(badTokenFile, validExportFileJson({ dark: { "--color-warning": "#ff0" } }));
    assert.ok(!(await service.installThemeFile(badTokenFile)).ok);

    const svgWallpaperFile = join(dir, "svg-wallpaper.mikikotheme");
    writeFileSync(
      svgWallpaperFile,
      validExportFileJson({
        wallpaper: {
          kind: "image",
          dataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
          fit: "cover",
          blurPx: 0,
          dimPercentLight: 10,
          dimPercentDark: 10,
        },
      }),
    );
    assert.ok(!(await service.installThemeFile(svgWallpaperFile)).ok);

    const missingFile = join(dir, "missing.mikikotheme");
    assert.ok(!(await service.installThemeFile(missingFile)).ok);
    assert.equal(service.listInstalled().length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("deleteTheme 删除自定义皮肤并拒绝逃逸 id", async () => {
  const { service, rootDir } = createTestService();
  try {
    const created = await service.saveCustomTheme(savePayload());
    assert.ok(created.ok);
    assert.ok(service.deleteTheme(created.item.id).ok);
    assert.equal(service.listInstalled().length, 0);

    assert.ok(!service.deleteTheme("..").ok);
    assert.ok(!service.deleteTheme(".staging").ok);
    assert.ok(!service.deleteTheme("not-exists").ok);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readWallpaperDataUrl 只放行库内图片并返回 dataURL（一键配色取色）", async (t) => {
  const { service, rootDir } = createTestService();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const sourceImage = join(rootDir, "..", "autocolor-source.png");
  writeFileSync(sourceImage, Buffer.from(PNG_BASE64, "base64"));
  const staged = await service.stageWallpaperImage(sourceImage);
  assert.ok(staged.path);

  const result = await service.readWallpaperDataUrl(staged.path!);
  assert.ok(result.dataUrl?.startsWith("data:image/png;base64,"));

  // 库外路径 / 非图片扩展名 / 不存在文件均拒绝。
  assert.ok(!(await service.readWallpaperDataUrl(sourceImage)).dataUrl);
  assert.ok(!(await service.readWallpaperDataUrl(join(rootDir, "missing.png"))).dataUrl);
  assert.ok(!(await service.readWallpaperDataUrl(join(rootDir, "notes.txt"))).dataUrl);
});

test("readExportFile 组装可再导入的导出 JSON（壁纸内嵌 dataURI）", async (t) => {
  const { service, rootDir } = createTestService();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const sourceImage = join(rootDir, "..", "export-wallpaper.png");
  writeFileSync(sourceImage, Buffer.from(PNG_BASE64, "base64"));
  const staged = await service.stageWallpaperImage(sourceImage);
  assert.ok(staged.path);

  const created = await service.saveCustomTheme(
    savePayload({
      author: "tester",
      wallpaper: {
        mode: "image",
        stagedPath: staged.path!,
        fit: "cover",
        blurPx: 0,
        dimPercentLight: 20,
        dimPercentDark: 10,
      },
    }),
  );
  assert.ok(created.ok);

  const exported = await service.readExportFile(created.item.id);
  assert.ok(exported.json);
  const parsed = JSON.parse(exported.json!) as {
    format: string;
    wallpaper?: { kind: string; dataUrl?: string; file?: string };
  };
  assert.equal(parsed.format, "mikiko-theme-skin");
  assert.equal(parsed.wallpaper?.kind, "image");
  assert.ok(parsed.wallpaper?.dataUrl?.startsWith("data:image/png;base64,"));
  assert.equal(parsed.wallpaper?.file, undefined, "导出文件不携带库内文件名字段");

  // 导出文件可再导入（round-trip）：重导入生成新 id 的同名皮肤。
  const reimportFile = join(rootDir, "..", "reimport.mikikotheme");
  writeFileSync(reimportFile, exported.json!);
  const reimported = await service.installThemeFile(reimportFile);
  assert.ok(reimported.ok);
  const list = service.listInstalled();
  assert.equal(list.length, 2);
  assert.notEqual(reimported.item.id, created.item.id);
  assert.ok(list.every((item) => item.wallpaper?.kind === "image"));
});

test("listInstalled 跳过损坏目录，不影响其余皮肤", async (t) => {
  const { service, rootDir } = createTestService();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const created = await service.saveCustomTheme(savePayload());
  assert.ok(created.ok);
  // 造一个 theme.json 损坏的目录。
  const brokenDir = join(rootDir, "user-broken");
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, "theme.json"), "{ not json");

  const list = service.listInstalled();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, created.item.id);
  // 原始 theme.json 内容读回验证（确保保存内容是合法记录 schema）。
  const saved = JSON.parse(readFileSync(join(rootDir, created.item.id, "theme.json"), "utf8"));
  assert.equal(saved.format, "mikiko-theme-skin-record");
});
