const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — " +
  "an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

// fused 预设在 detailed 模板之上追加的可执行事实段落与多次压缩合并规则。
const DETAILED_PLUS_EXTRA_SECTIONS = `
In addition to the sections above, your summary MUST also include:

10. Files Read and Examined: List every file you read, grepped, or examined, as \`path (lines a-b) — one-line purpose\`. Include files from earlier in the conversation, not just recent ones. Keep code at signature level unless a snippet is essential.
11. Environment and Workspace Facts: Restate durable environment facts still in effect (git state snapshot, key paths, confirmed tooling/version facts). Do not restate transient command output.
12. Current Todo and Plan: Reproduce the current todo list verbatim if one exists, plus any approved plan file path.

Additional rules:
- If the conversation already contains a prior compaction summary, do NOT copy it forward verbatim: preserve still-true facts, drop stale ones, and merge everything into one consolidated summary with the same section structure.`;

// deepseek-style：对齐 DeepSeek Harness compaction-basic 的 8 段 checkpoint 模板。
const CHECKPOINT_8_PROMPT = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`;

// codex-style：对齐 Codex 的 handoff 模板。
const HANDOFF_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:${" "}
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.${" "}

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>`;

export function buildCompactPrompt(
  customInstructions: string | undefined,
  template: "detailed" | "detailed-plus" | "checkpoint-8" | "handoff" = "detailed",
): string {
  const customInstructionBlock = customInstructions?.trim()
    ? `\n\nAdditional Instructions:\n${customInstructions}`
    : "";

  // checkpoint-8 / handoff 自带完整结构，不叠加 detailed 的 analysis/summary 包装说明。
  if (template === "checkpoint-8") {
    return `${NO_TOOLS_PREAMBLE}${CHECKPOINT_8_PROMPT}${customInstructionBlock}${NO_TOOLS_TRAILER}`;
  }
  if (template === "handoff") {
    return `${NO_TOOLS_PREAMBLE}${HANDOFF_PROMPT}${customInstructionBlock}${NO_TOOLS_TRAILER}`;
  }

  const extraSections = template === "detailed-plus" ? DETAILED_PLUS_EXTRA_SECTIONS : "";
  return `${NO_TOOLS_PREAMBLE}${BASE_COMPACT_PROMPT}${extraSections}${customInstructionBlock}${NO_TOOLS_TRAILER}`;
}

export function formatCompactSummary(text: string | undefined): string {
  let formatted = text?.trim() ?? "";
  if (!formatted) return "";

  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const summary = summaryMatch[1] || "";
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${summary.trim()}`);
  }

  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

export function buildCompactSummaryMessage(
  summary: string,
  options: {
    preamble?: "continue" | "handoff";
    recentMessagesPreserved?: boolean;
    replStateCleared?: boolean;
    suppressFollowup?: boolean;
    transcriptPath?: string;
  } = {},
): string {
  // codex-style 用 handoff 导语对齐 Codex 的 SUMMARY_PREFIX；默认保持现有延续语义。
  const lead =
    options.preamble === "handoff"
      ? `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`
      : `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.`;
  let message = `${lead}

${formatCompactSummary(summary)}`;

  if (options.transcriptPath) {
    message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${options.transcriptPath}`;
  }

  if (options.recentMessagesPreserved) {
    message += "\n\nRecent messages are preserved verbatim.";
  }

  if (options.replStateCleared) {
    message +=
      "\n\nYour REPL VM state has been cleared as part of this compaction. Variables defined in REPL calls before this point are no longer accessible — redefine any you still need.";
  }

  if (options.suppressFollowup) {
    message +=
      '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
  }

  return message;
}
