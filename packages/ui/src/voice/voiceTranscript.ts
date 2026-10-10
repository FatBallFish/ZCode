/**
 * 语音转录结果回填事件 —— specs/desktop/voice-input.md §3.2。
 * controller（App 级单例）产出转录文本后广播 window 事件；
 * 聚焦会话的 ConversationComposer 消费并追加到输入框末尾（与「加入对话」事件同构，
 * 避免 composer 外部插入路径分叉）。payload 不含 workspace：仅聚焦 composer 监听。
 */
import type { MutableRefObject } from "react";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";

export const VOICE_TRANSCRIPT_APPEND_EVENT = "zcode:voice-transcript-append";

export interface VoiceTranscriptAppendDetail {
  text: string;
}

export function dispatchVoiceTranscriptAppend(text: string): void {
  window.dispatchEvent(
    new CustomEvent<VoiceTranscriptAppendDetail>(VOICE_TRANSCRIPT_APPEND_EVENT, {
      detail: { text },
    }),
  );
}

export function isVoiceTranscriptAppendEvent(
  event: Event,
): event is CustomEvent<VoiceTranscriptAppendDetail> {
  return event.type === VOICE_TRANSCRIPT_APPEND_EVENT;
}

/** 追加到输入框末尾并聚焦；保持受控 text 状态与编辑器内容一致（同 add-to-chat 模式）。
 * Lexical 的 appendEditorPlainText 追加到末段并按需补一个空格、不支持段内换行 ——
 * 这里把转录折叠为单行并镜像同一空格规则，markdown 状态与编辑器不漂移。 */
export function appendVoiceTranscriptToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  text: string;
  onTextChange: (text: string) => void;
}): string {
  const collapsed = params.text
    .trim()
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  if (collapsed.length === 0) return params.currentMarkdown;
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown) ? " " : "";
  const nextText = `${params.currentMarkdown}${separator}${collapsed}`;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendText(collapsed);
  params.inputApiRef.current?.focus();
  return nextText;
}
