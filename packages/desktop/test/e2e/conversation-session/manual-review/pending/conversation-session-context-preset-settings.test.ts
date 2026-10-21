import {
  TID_SETTINGS_AGENT_CONTEXT_PRESET_OPTION,
  TID_SETTINGS_AGENT_CONTEXT_PRESET_SELECT,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, clearAppData, readSettings } from "../../../helpers/desktop-app.js";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequestContaining,
} from "../../../helpers/conversation-session-network.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
} from "../../../helpers/v4-conversation.js";


/**
 * Agent 上下文预设（agentContextPreset）设置与请求投影 E2E：
 * 1) 设置项四选项可切换且持久化；
 * 2) default 预设保持 legacy 断点布局（双 system 断点，附件不打断点）；
 * 3) 切换 fused 后新建会话（冷读取）请求变为 anchored 布局（最后 system 断点 +
 *    会话附件断点），且总断点数不超过 4。
 */
describe("Agent 上下文预设 Settings E2E", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PS1: 默认布局断言、fused 切换持久化与 anchored 布局冷会话生效", async function () {
    this.timeout(300_000);

    // --- default：legacy 断点布局 ---
    await startNewV4Draft();
    const defaultMarker = "E2E_CONTEXT_PRESET_DEFAULT_LAYOUT";
    await sendV4Prompt(`${defaultMarker} 检查默认断点布局。`);
    await waitForUpstreamRequestContaining(defaultMarker, 120_000);
    const defaultRecord = latestRecord(
      await getUpstreamRequestEvidence({ includes: [defaultMarker] }),
    );
    expect((await readSettings()).agentContextPreset ?? "default").toBe("default");
    expectSystemCacheLayout(defaultRecord, { markedSystemBlocks: 2 });
    expect(contextPrefixMessage(defaultRecord)?.cacheControl).toBeUndefined();

    // --- 设置页：四选项存在并切换 fused ---
    await openSettings();
    const select = await browser.$(`[data-testid="${TID_SETTINGS_AGENT_CONTEXT_PRESET_SELECT}"]`);
    await select.scrollIntoView();
    expect(await select.getText()).toMatch(/^(默认|Default)$/u);
    await select.click();
    const option = await browser.$(
      `[data-testid="${testId(TID_SETTINGS_AGENT_CONTEXT_PRESET_OPTION, "fused")}"]`,
    );
    await option.waitForDisplayed({ timeout: 10_000 });
    await option.click();
    await browser.waitUntil(
      async () => (await readSettings()).agentContextPreset === "fused",
      { timeout: 15_000, timeoutMsg: "agentContextPreset=fused 没有保存" },
    );
    await closeSettings();

    // --- 新任务冷读取 fused：anchored 断点布局 ---
    await startNewV4Draft();
    const fusedMarker = "E2E_CONTEXT_PRESET_FUSED_LAYOUT";
    await sendV4Prompt(`${fusedMarker} 检查 anchored 断点布局。`);
    await waitForUpstreamRequestContaining(fusedMarker, 120_000);
    const fusedRecord = latestRecord(
      await getUpstreamRequestEvidence({ includes: [fusedMarker] }),
    );

    expectSystemCacheLayout(fusedRecord, { markedSystemBlocks: 1 });
    // anchored 的核心差异：会话稳定附件（context_prefix <system-reminder>）成为断点，
    // 压缩后可整段命中 system+AGENTS.md/skills 前缀。
    expect(contextPrefixMessage(fusedRecord)?.cacheControl).toEqual({ type: "ephemeral" });
    expect(totalCacheControlMarks(fusedRecord)).toBeLessThanOrEqual(4);
  });
});

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 15_000 });
  await browser
    .$(`[data-testid="${TID_SETTINGS_AGENT_CONTEXT_PRESET_SELECT}"]`)
    .waitForExist({ timeout: 15_000 });
}

async function closeSettings() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
}

interface RequestCapture {
  requestJson: unknown;
}

function latestRecord<T extends RequestCapture>(records: readonly T[]): T {
  const record = records.at(-1);
  if (!record) {
    throw new Error("没有匹配的上游请求记录");
  }
  return record;
}

function systemBlocks(record: RequestCapture): Array<{ cache_control?: unknown }> {
  const system = (record.requestJson as { system?: unknown }).system;
  if (typeof system === "string") {
    return [{}, ...systemSplitMarkers(system)];
  }
  return Array.isArray(system) ? (system as Array<{ cache_control?: unknown }>) : [];
}

function systemSplitMarkers(system: string): Array<Record<string, unknown>> {
  return system ? [{}] : [];
}

function messages(record: RequestCapture): Array<Record<string, unknown>> {
  const value = (record.requestJson as { messages?: unknown }).messages;
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function blockText(block: unknown): string {
  if (block && typeof block === "object" && "text" in block) {
    return String((block as { text?: unknown }).text ?? "");
  }
  return "";
}

/** 找到携带 <system-reminder> 的第一条 user 消息（context_prefix 附件投影）。 */
function contextPrefixMessage(
  record: RequestCapture,
): { cacheControl?: unknown } | undefined {
  for (const message of messages(record)) {
    if (message.role !== "user") continue;
    const content = message.content;
    const blocks = Array.isArray(content)
      ? (content as unknown[])
      : content === undefined || typeof content === "string"
        ? [{ text: String(content ?? "") }]
        : [];
    if (blocks.some((block) => blockText(block).includes("<system-reminder"))) {
      const marked = blocks.find(
        (block) =>
          block &&
          typeof block === "object" &&
          "cache_control" in (block as Record<string, unknown>),
      );
      return {
        cacheControl: marked
          ? (marked as { cache_control?: unknown }).cache_control
          : (message as { cache_control?: unknown }).cache_control,
      };
    }
  }
  return undefined;
}

function expectSystemCacheLayout(
  record: RequestCapture,
  expected: { markedSystemBlocks: number },
) {
  const blocks = systemBlocks(record);
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  const marked = blocks.filter((block) => "cache_control" in block);
  expect(marked.length).toBe(expected.markedSystemBlocks);
  if (expected.markedSystemBlocks > 0) {
    // 断点必须落在尾部连续的 system 块（legacy 双断点或 anchored 单断点）。
    expect(blocks.slice(-expected.markedSystemBlocks).every((block) => "cache_control" in block)).toBe(
      true,
    );
    expect("cache_control" in blocks[0]!).toBe(false);
  }
}

function totalCacheControlMarks(record: RequestCapture): number {
  return JSON.stringify(record.requestJson).split('"cache_control"').length - 1;
}
