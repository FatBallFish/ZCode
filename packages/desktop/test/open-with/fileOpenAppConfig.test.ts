import assert from "node:assert/strict";
import test from "node:test";
import {
  EDITOR_APP_IDS,
  FILE_OPEN_APP_DEFS,
  FILE_OPEN_FORMAT_RULES,
  resolveFileOpenAppIdsForExtension,
} from "../../src/main/fileOpenAppConfig.js";

/**
 * 格式规则表解析（specs/desktop/file-open-methods.md）：
 * 扩展名 → 有序应用 id；多规则命中按声明顺序合并去重；未知扩展返回空；
 * 规则表 appIds 必须全部可解析（格式应用 defs ∪ 平台编辑器 id 副本）。
 */

test("文档/表格/演示/PDF：办公应用在前", () => {
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".docx"), ["wps", "word", "pages"]);
  assert.deepEqual(resolveFileOpenAppIdsForExtension("xlsx"), ["wps", "excel", "numbers"]);
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".pptx"), ["wps", "powerpoint", "keynote"]);
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".pdf"), ["wps", "adobe-acrobat"]);
});

test("编程语言：专用 IDE 在前，通用编辑器由 code 规则追加且去重", () => {
  const goApps = resolveFileOpenAppIdsForExtension(".go");
  assert.equal(goApps[0], "goland");
  assert.ok(goApps.includes("vscode"));
  assert.ok(goApps.includes("sublime"));
  assert.equal(new Set(goApps).size, goApps.length);

  const tsApps = resolveFileOpenAppIdsForExtension("ts");
  assert.equal(tsApps[0], "webstorm");
  assert.ok(tsApps.includes("vscode"));

  const javaApps = resolveFileOpenAppIdsForExtension(".java");
  assert.deepEqual(javaApps.slice(0, 2), ["idea", "idea-ce"]);
  assert.ok(javaApps.includes("vscode"));
});

test("音视频与 Adobe 系列各归对应应用", () => {
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".psd"), ["adobe-photoshop"]);
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".ai"), ["adobe-illustrator"]);
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".prproj"), ["adobe-premiere-pro"]);
  const mp3Apps = resolveFileOpenAppIdsForExtension(".mp3");
  assert.equal(mp3Apps[0], "vlc");
  assert.ok(mp3Apps.includes("music"));
  assert.ok(!mp3Apps.includes("wps"));
});

test("多规则命中按声明顺序合并（html 同时命中 web-lang 与 code）", () => {
  const htmlApps = resolveFileOpenAppIdsForExtension(".html");
  assert.equal(htmlApps[0], "webstorm");
  assert.ok(htmlApps.includes("vscode"));
  assert.equal(new Set(htmlApps).size, htmlApps.length);
});

test("扩展名大小写与点前缀归一；未知扩展返回空", () => {
  assert.deepEqual(
    resolveFileOpenAppIdsForExtension(".XLSX"),
    resolveFileOpenAppIdsForExtension("xlsx"),
  );
  assert.deepEqual(resolveFileOpenAppIdsForExtension(""), []);
  assert.deepEqual(resolveFileOpenAppIdsForExtension(".xyzunknown"), []);
  assert.deepEqual(resolveFileOpenAppIdsForExtension("a/b"), []);
});

test("规则表 appIds 全部可解析为格式应用 defs 或平台编辑器 id", () => {
  const knownIds = new Set<string>([...FILE_OPEN_APP_DEFS.map((def) => def.id), ...EDITOR_APP_IDS]);
  for (const rule of FILE_OPEN_FORMAT_RULES) {
    for (const appId of rule.appIds) {
      assert.ok(knownIds.has(appId), `规则 ${rule.id} 引用了未知应用 id: ${appId}`);
    }
  }
});

test("格式应用 defs 内部 id 无重复", () => {
  const ids = FILE_OPEN_APP_DEFS.map((def) => def.id);
  assert.equal(new Set(ids).size, ids.length);
});
