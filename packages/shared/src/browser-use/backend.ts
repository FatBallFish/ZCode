import { z } from "zod";
import { browserClientModeSchema } from "./commands.js";

/**
 * Browser backend family。Playwright 是 Tab 上的能力层，不是 backend。
 */
export const browserBackendTypeSchema = z.enum(["iab", "extension", "cdp"]);
export type BrowserBackendType = z.infer<typeof browserBackendTypeSchema>;

/** 单项 browser/tab capability 的稳定描述。 */
export const browserCapabilityDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();
export type BrowserCapabilityDescriptor = z.infer<typeof browserCapabilityDescriptorSchema>;

/**
 * 可达 browser backend 的运行时描述。
 *
 * id 是 connection identity，同一 type 可以同时存在多个实例；只有完成握手并真实可用的
 * backend 才能出现在 discovery 结果中。
 */
export const browserBackendDescriptorSchema = z
  .object({
    id: z.string().trim().min(1),
    /** 同一 runtime id 的连接代次；旧代次对象不得自动漂移到新连接。 */
    generation: z.number().int().nonnegative().default(0),
    type: browserBackendTypeSchema,
    name: z.string().trim().min(1),
    capabilities: z
      .object({
        browser: z.array(browserCapabilityDescriptorSchema).optional(),
        tab: z.array(browserCapabilityDescriptorSchema).optional(),
      })
      .strict(),
    apiSupportOverrides: z.record(z.string(), z.boolean()).optional(),
    /** metadata 只允许非敏感字符串，禁止把 credential 混入 discovery。 */
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserBackendDescriptor = z.infer<typeof browserBackendDescriptorSchema>;

/** backend request 使用实时 session，或使用已缓存的 session context。 */
export const browserSessionContextKindSchema = z.enum(["live", "cached"]);
export type BrowserSessionContextKind = z.infer<typeof browserSessionContextKindSchema>;

/**
 * Discovery 的完整隔离上下文。workspaceKey 用于身份隔离，workspacePath 仅用于路径语义。
 */
export const browserDiscoveryContextSchema = z
  .object({
    requestId: z.string().trim().min(1),
    workspaceKey: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type BrowserDiscoveryContext = z.infer<typeof browserDiscoveryContextSchema>;

/** 执行命令时在 discovery context 上增加精确 runtime browser identity。 */
export const browserSessionContextSchema = browserDiscoveryContextSchema
  .extend({
    browserId: z.string().trim().min(1),
    browserGeneration: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserSessionContext = z.infer<typeof browserSessionContextSchema>;

/** ZCode Protocol 的 discovery result 包装；port 层会解包并直接返回 browsers。 */
export const browserBackendListResultSchema = z
  .object({ browsers: z.array(browserBackendDescriptorSchema) })
  .strict();
export type BrowserBackendListResult = z.infer<typeof browserBackendListResultSchema>;

/**
 * 外部浏览器（external CDP）内置默认配置：不配置任何来源时按默认端口 9333 挂载一个
 * 实例，实现「零配置可用」。9333 无监听时该实例从发现列表消失，不影响 IAB 与其他实例。
 * main（解析注入/推送）与 host（env 缺失兜底）共用，避免两处字符串漂移。
 */
export const DEFAULT_EXTERNAL_CDP_CONFIGURATION =
  '{"instances":[{"id":"default","endpoint":"http://127.0.0.1:9333"}]}';

/** main 在 spawn window Host 时注入的外部浏览器实例配置 env（已解析+校验的最终 JSON）。 */
export const EXTERNAL_CDP_CONFIGURATION_ENV = "MIKIKO_EXTERNAL_CDP";
/** main 在 spawn window Host 时注入的远控开关 env（"0"=禁止手机远控使用外部浏览器）。 */
export const EXTERNAL_CDP_REMOTE_CONTROL_ENV = "MIKIKO_EXTERNAL_CDP_REMOTE_CONTROL";
