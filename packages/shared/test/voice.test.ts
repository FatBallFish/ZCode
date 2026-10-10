import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODEL_MANIFESTS,
  VOICE_VAD_ARTIFACT,
  findVoiceModelManifest,
  voiceModelManifestSchema,
  voiceStateSnapshotSchema,
} from "../src/voice.js";

test("内置语音模型清单：全部通过 schema 校验且 id 唯一", () => {
  const ids = new Set<string>();
  for (const manifest of VOICE_MODEL_MANIFESTS) {
    const parsed = voiceModelManifestSchema.safeParse(manifest);
    assert.equal(parsed.success, true, `manifest ${manifest.id} schema 校验失败`);
    assert.equal(ids.has(manifest.id), false, `模型 id 重复：${manifest.id}`);
    ids.add(manifest.id);
  }
  assert.ok(VOICE_MODEL_MANIFESTS.length >= 3);
});

test("默认模型存在且为离线分段型（首版默认 SenseVoice）", () => {
  const manifest = findVoiceModelManifest(DEFAULT_VOICE_MODEL_ID);
  assert.ok(manifest);
  assert.equal(manifest.recommendedFor, "default");
  assert.equal(manifest.streaming, false);
  assert.equal(manifest.requiresVad, true);
});

test("模型文件下载项：https、sha256 形状与磁盘预估一致", () => {
  for (const manifest of VOICE_MODEL_MANIFESTS) {
    assert.ok(manifest.files.length > 0);
    let totalBytes = 0;
    for (const file of manifest.files) {
      assert.ok(file.url.startsWith("https://"), `${manifest.id}/${file.path} url 非 https`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(file.sizeBytes > 0);
      if (file.mirrorUrl) assert.ok(file.mirrorUrl.startsWith("https://"));
      totalBytes += file.sizeBytes;
    }
    // 磁盘预估 = 文件字节数（MB 换算允许 1MB 舍入误差）。
    assert.ok(
      Math.abs(manifest.approxDiskMb - totalBytes / (1024 * 1024)) < 2,
      `${manifest.id} approxDiskMb 与文件总量不符`,
    );
  }
});

test("VAD 共享依赖：qwen3/sensevoice（离线分段）都要求 VAD，流式模型不要求", () => {
  assert.match(VOICE_VAD_ARTIFACT.sha256, /^[0-9a-f]{64}$/);
  for (const manifest of VOICE_MODEL_MANIFESTS) {
    assert.equal(
      manifest.requiresVad,
      manifest.kind !== "zipformer-streaming",
      `${manifest.id} requiresVad 与引擎子类型不一致`,
    );
  }
});

test("状态快照 schema：合法快照通过、缺 activeSession 字段拒绝", () => {
  const valid = {
    supported: true,
    models: [
      { modelId: "sensevoice-int8", install: { status: "not-installed" } },
      {
        modelId: "qwen3-asr-0.6b-int8",
        install: { status: "downloading", receivedBytes: 1, totalBytes: 10, activeFile: "a" },
      },
    ],
    vadInstalled: false,
    loadedModelId: null,
    activeSession: { sessionId: "s1", modelId: "sensevoice-int8", startedAt: 1 },
  };
  assert.equal(voiceStateSnapshotSchema.safeParse(valid).success, true);
  assert.equal(voiceStateSnapshotSchema.safeParse({ supported: true }).success, false);
});
