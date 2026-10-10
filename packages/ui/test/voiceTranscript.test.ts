import assert from "node:assert/strict";
import test from "node:test";

import { appendVoiceTranscriptToComposer } from "../src/voice/voiceTranscript.js";
import type { LexicalChatInputHandle } from "../src/LexicalChatInput.js";

function createFakeInputApi() {
  const appended: string[] = [];
  let focused = 0;
  const handle = {
    clear: () => {},
    focus: () => {
      focused += 1;
    },
    appendText: (text: string) => {
      appended.push(text);
    },
  } as unknown as LexicalChatInputHandle;
  return { handle, appended, focusCount: () => focused };
}

test("空草稿：直接追加转录文本", () => {
  const fake = createFakeInputApi();
  const texts: string[] = [];
  const next = appendVoiceTranscriptToComposer({
    inputApiRef: { current: fake.handle },
    currentMarkdown: "",
    text: "整理后的文案",
    onTextChange: (value) => texts.push(value),
  });
  assert.equal(next, "整理后的文案");
  assert.deepEqual(texts, ["整理后的文案"]);
  assert.deepEqual(fake.appended, ["整理后的文案"]);
  assert.equal(fake.focusCount(), 1);
});

test("已有草稿：补一个空格后追加，不破坏原文（与编辑器 append 规则一致）", () => {
  const fake = createFakeInputApi();
  const next = appendVoiceTranscriptToComposer({
    inputApiRef: { current: fake.handle },
    currentMarkdown: "之前的问题",
    text: "新的语音内容",
    onTextChange: () => {},
  });
  assert.equal(next, "之前的问题 新的语音内容");
  assert.deepEqual(fake.appended, ["新的语音内容"]);
});

test("草稿以空白结尾：不再补空格", () => {
  const fake = createFakeInputApi();
  const next = appendVoiceTranscriptToComposer({
    inputApiRef: { current: fake.handle },
    currentMarkdown: "已有内容 ",
    text: "继续说",
    onTextChange: () => {},
  });
  assert.equal(next, "已有内容 继续说");
  assert.deepEqual(fake.appended, ["继续说"]);
});

test("多行转录折叠为单行追加（Lexical 段内不支持换行，markdown 与编辑器不漂移）", () => {
  const fake = createFakeInputApi();
  const next = appendVoiceTranscriptToComposer({
    inputApiRef: { current: fake.handle },
    currentMarkdown: "draft",
    text: "第一段\n\n第二段\n第三段",
    onTextChange: () => {},
  });
  assert.equal(next, "draft 第一段 第二段 第三段");
  assert.deepEqual(fake.appended, ["第一段 第二段 第三段"]);
});

test("空转录：原样返回，不触发编辑器变更", () => {
  const fake = createFakeInputApi();
  let changed = false;
  const next = appendVoiceTranscriptToComposer({
    inputApiRef: { current: fake.handle },
    currentMarkdown: "draft",
    text: "   ",
    onTextChange: () => {
      changed = true;
    },
  });
  assert.equal(next, "draft");
  assert.equal(changed, false);
  assert.deepEqual(fake.appended, []);
  assert.equal(fake.focusCount(), 0);
});
