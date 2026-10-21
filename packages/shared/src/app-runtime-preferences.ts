import { z } from "zod";

export const appToolSearchModeSchema = z.enum(["auto", "local", "off"]);
export type AppToolSearchMode = z.infer<typeof appToolSearchModeSchema>;

// Agent 上下文策略预设：系统提示词缓存断点布局 + 会话压缩算法的联合预设（CLI core 的
// compact/preset 是语义唯一所有者，这里只定义 AppSettings/协议边界的枚举形状）。
// 与 toolSearchMode 同语义：新建或冷恢复 Session 读取，会话中不变；缺省 default 保持既有行为。
export const appAgentContextPresetSchema = z.enum([
  "default",
  "fused",
  "deepseek-style",
  "codex-style",
]);
export type AppAgentContextPreset = z.infer<typeof appAgentContextPresetSchema>;

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
