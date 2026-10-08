import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePetSessionSummaries,
  mapRowsToPetSummaries,
  resolvePetAnimationState,
  type PetSessionSummary,
} from "@zcode/shared";
import type { WindowHostControllerTaskRow } from "@zcode/shared/zcode-protocol-v4";
import { computeBubbleBounds } from "../../src/main/desktopPetBubbleBounds.js";

/** 宠物会话摘要（specs/desktop/desktop-pet.md 会话状态气泡）：过滤/排序/合并/动画优先级/气泡定位。 */

let sequence = 0;

function row(overrides: {
  taskId: string;
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  unreadAt?: number;
  lastAssistantPreview?: string;
  pendingInteraction?: { kind: "permission" | "userInput"; toolName?: string };
  pendingCounts?: { permissionCount: number; userInputCount: number };
  workspaceIdentity?: string;
}): WindowHostControllerTaskRow {
  sequence += 1;
  return {
    address: {
      taskId: overrides.taskId,
      workspacePath: "/ws",
      ...(overrides.workspaceIdentity ? { workspaceIdentity: overrides.workspaceIdentity } : {}),
    },
    meta: {
      taskId: overrides.taskId,
      traceId: `trace-${sequence}`,
      title: `任务 ${overrides.taskId}`,
      workspacePath: "/ws",
      ...(overrides.workspaceIdentity ? { workspaceIdentity: overrides.workspaceIdentity } : {}),
      createdAt: sequence,
      updatedAt: sequence,
      mode: "agent",
      ...(overrides.unreadAt != null ? { unreadAt: overrides.unreadAt } : {}),
      ...(overrides.pendingInteraction ? { pendingInteraction: overrides.pendingInteraction } : {}),
    },
    membership: { pinned: false, archived: false, active: true },
    sourceAvailability: "online",
    liveStatus: overrides.liveStatus,
    activity: {
      phase: "running",
      lastActivityAt: sequence,
      hasBackgroundWork: false,
      ...(overrides.pendingCounts ? { pendingInteractions: overrides.pendingCounts } : {}),
      ...(overrides.lastAssistantPreview
        ? { lastAssistantPreview: overrides.lastAssistantPreview }
        : {}),
    },
  };
}

test("过滤：running/waiting 全保留；completed/error 仅未读；idle 不进气泡", () => {
  const rows = mapRowsToPetSummaries([
    row({ taskId: "run", liveStatus: "running" }),
    row({ taskId: "wait", liveStatus: "waiting" }),
    row({ taskId: "done-unread", liveStatus: "completed", unreadAt: 1 }),
    row({ taskId: "done-read", liveStatus: "completed" }),
    row({ taskId: "err-unread", liveStatus: "error", unreadAt: 1 }),
    row({ taskId: "err-read", liveStatus: "error" }),
    row({ taskId: "idle", liveStatus: "idle", unreadAt: 1 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.taskId).sort(),
    ["run", "wait", "done-unread", "err-unread"].sort(),
  );
});

test("排序：waiting > running > error(未读) > completed(未读)", () => {
  const rows = mapRowsToPetSummaries([
    row({ taskId: "done", liveStatus: "completed", unreadAt: 1 }),
    row({ taskId: "err", liveStatus: "error", unreadAt: 1 }),
    row({ taskId: "run", liveStatus: "running" }),
    row({ taskId: "wait", liveStatus: "waiting" }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.liveStatus),
    ["waiting", "running", "error", "completed"],
  );
});

test("pendingKind 优先 meta 再从计数推导；preview 透传；merge 层裁上限", () => {
  const many = mapRowsToPetSummaries(
    Array.from({ length: 8 }, (_, i) =>
      row({ taskId: `t${i}`, liveStatus: "running", lastAssistantPreview: `消息${i}` }),
    ),
  );
  assert.equal(many.length, 8, "host 全量上报，裁剪在 main 合并层");
  const mergedMany = mergePetSessionSummaries([many]);
  assert.equal(mergedMany.rows.length, 6);
  assert.equal(mergedMany.overflowCount, 2);
  assert.equal(mergedMany.rows[0]?.lastPreview, "消息0");

  const [metaKind] = mapRowsToPetSummaries([
    row({
      taskId: "a",
      liveStatus: "waiting",
      pendingInteraction: { kind: "userInput", toolName: "选择方案" },
    }),
  ]);
  assert.equal(metaKind?.pendingKind, "userInput");
  assert.equal(metaKind?.pendingToolName, "选择方案");

  const [countKind] = mapRowsToPetSummaries([
    row({
      taskId: "b",
      liveStatus: "waiting",
      pendingCounts: { permissionCount: 0, userInputCount: 2 },
    }),
  ]);
  assert.equal(countKind?.pendingKind, "userInput");
});

test("merge：跨 host 按 taskKey 去重（远端 identity 与本地路径不冲突）+ 重新排序", () => {
  const local: PetSessionSummary[] = [
    {
      taskId: "t1",
      workspacePath: "/ws",
      title: "本地运行",
      liveStatus: "running",
      unread: false,
    },
  ];
  const remote: PetSessionSummary[] = [
    {
      taskId: "t1",
      workspacePath: "/remote",
      workspaceIdentity: "remote-authority://x",
      title: "远端同 id",
      liveStatus: "waiting",
      unread: false,
    },
    {
      taskId: "t1",
      workspacePath: "/ws",
      title: "本地 t1 的 host 后到覆盖",
      liveStatus: "completed",
      unread: true,
    },
  ];
  const { rows } = mergePetSessionSummaries([local, remote]);
  assert.equal(rows.length, 2, "远端 identity 与本地同 taskId 是两个会话；本地路径重复取后者");
  assert.equal(rows[0]?.liveStatus, "waiting");
  assert.equal(rows[1]?.title, "本地 t1 的 host 后到覆盖");
});

test("动画优先级（视觉语义）：waiting会话→running催促 > running会话→waiting工作 > failed > review", () => {
  // 官方图集第 6 行 waiting=对电脑工作、第 7 行 running=原地小跑：
  // 会话进行中呈现"工作"而非"跑步"；等待用户用"小跑"表达催促。
  assert.equal(resolvePetAnimationState([{ liveStatus: "waiting", unread: false }], 0), "running");
  assert.equal(resolvePetAnimationState([{ liveStatus: "running", unread: false }], 0), "waiting");
  assert.equal(resolvePetAnimationState([{ liveStatus: "error", unread: true }], 0), "failed");
  assert.equal(resolvePetAnimationState([{ liveStatus: "completed", unread: true }], 0), "review");
  assert.equal(
    resolvePetAnimationState([{ liveStatus: "completed", unread: false }], 3),
    "waiting",
  );
  assert.equal(resolvePetAnimationState([], 0), "idle");
  assert.equal(resolvePetAnimationState([], 2), "waiting", "无摘要时运行计数兜底（工作视觉）");
});

test("终态宽限期（2 分钟）：完成后未打未读也展示；过期且无未读才彻底消失", () => {
  const now = 1_000_000;
  const fresh = row({ taskId: "fresh", liveStatus: "completed" });
  fresh.meta.updatedAt = now - 100_000; // 100s 前终态（2 分钟宽限内），未读未打（主窗口可能已关）
  const stale = row({ taskId: "stale", liveStatus: "completed" });
  stale.meta.updatedAt = now - 130_000; // 130s 前终态且无未读 → 移除
  const staleUnread = row({ taskId: "stale-unread", liveStatus: "completed", unreadAt: 1 });
  staleUnread.meta.updatedAt = now - 120_000;
  const rows = mapRowsToPetSummaries([fresh, stale, staleUnread], now);
  assert.deepEqual(rows.map((r) => r.taskId).sort(), ["fresh", "stale-unread"].sort());
});

test("气泡定位：宠物正上方居中；顶部放不下放下方；workArea 夹取", () => {
  const workArea = { x: 0, y: 0, width: 1512, height: 958 };
  const petBottom = { x: 700, y: 778, width: 115, height: 125 };
  const above = computeBubbleBounds(petBottom, 200, workArea);
  assert.equal(above.width, 320);
  assert.equal(above.x, 700 + Math.round(115 / 2) - 160, "水平居中于宠物");
  assert.equal(above.y, 778 - 200 - 10, "默认放宠物上方");

  const petRightEdge = { x: 1373, y: 778, width: 115, height: 125 };
  const rightClamped = computeBubbleBounds(petRightEdge, 200, workArea);
  assert.equal(rightClamped.x, 1512 - 320, "居中会溢出右边界时贴右边夹取");

  const petTop = { x: 100, y: 5, width: 115, height: 125 };
  const below = computeBubbleBounds(petTop, 200, workArea);
  assert.equal(below.y, 5 + 125 + 10, "上方放不下放宠物下方");

  const petLeftEdge = { x: 0, y: 900, width: 115, height: 125 };
  const clamped = computeBubbleBounds(petLeftEdge, 100, workArea);
  assert.equal(clamped.x, 0, "夹取在 workArea 左边界");
});
