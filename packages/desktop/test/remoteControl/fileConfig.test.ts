import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRemoteControlFileConfig,
  readRemoteControlFileConfig,
  REMOTE_CONTROL_DEFAULT_FILE_CONFIG,
} from "../../src/main/remoteControl/fileConfig.js";

/**
 * 配置文件启动自检（spec §21.10）：不存在 → 写默认值；存在 → 不操作；
 * 读取侧无文件/坏 JSON → 空配置；enabled 仅显式 false 视为停用。
 */

function tempConfigPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `rc-config-${name}-`)), "remote-control.json");
}

test("ensureRemoteControlFileConfig：文件不存在时写入默认值（mikiko.ai 端点 + enabled=true）", () => {
  const path = tempConfigPath("create");
  const result = ensureRemoteControlFileConfig(path);
  assert.equal(result, "created");
  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(written, { ...REMOTE_CONTROL_DEFAULT_FILE_CONFIG });
  assert.equal(written.enabled, true);
  assert.equal(typeof written.relayWsUrl, "string");
  assert.match(String(written.relayWsUrl), /^wss:\/\//);
});

test("ensureRemoteControlFileConfig：文件已存在（含用户自定义）时不改写", () => {
  const path = tempConfigPath("exists");
  const custom = { enabled: false, relayWsUrl: "wss://custom.example.com/ws/desktop" };
  writeFileSync(path, JSON.stringify(custom), "utf8");
  const result = ensureRemoteControlFileConfig(path);
  assert.equal(result, "exists");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), custom);
});

test("ensureRemoteControlFileConfig：幂等——二次调用保持 created 后的内容", () => {
  const path = tempConfigPath("idempotent");
  assert.equal(ensureRemoteControlFileConfig(path), "created");
  assert.equal(ensureRemoteControlFileConfig(path), "exists");
  assert.equal(readRemoteControlFileConfig(path).enabled, true);
});

test("ensureRemoteControlFileConfig：父目录不存在时一并创建；不可写路径返回 failed", () => {
  const root = mkdtempSync(join(tmpdir(), "rc-config-nested-"));
  const path = join(root, ".mikiko", "remote-control.json");
  assert.equal(ensureRemoteControlFileConfig(path), "created");
  assert.ok(existsSync(path));

  // 父路径是一个普通文件 → mkdir 失败 → failed（不抛出，不阻断启动）。
  const fileAsParent = join(root, "not-a-dir");
  writeFileSync(fileAsParent, "", "utf8");
  assert.equal(ensureRemoteControlFileConfig(join(fileAsParent, "remote-control.json")), "failed");
});

test("readRemoteControlFileConfig：无文件/坏 JSON 归空配置，enabled 字段透传", () => {
  assert.deepEqual(readRemoteControlFileConfig(tempConfigPath("missing")), {});
  const bad = tempConfigPath("bad");
  writeFileSync(bad, "{not json", "utf8");
  assert.deepEqual(readRemoteControlFileConfig(bad), {});

  const custom = tempConfigPath("custom");
  writeFileSync(custom, JSON.stringify({ enabled: false, relayWsUrl: "wss://x/ws" }), "utf8");
  const parsed = readRemoteControlFileConfig(custom);
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.relayWsUrl, "wss://x/ws");
});
