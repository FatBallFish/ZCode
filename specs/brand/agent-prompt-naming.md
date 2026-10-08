# 模型可见内置 Prompt 的产品命名（Mikiko）

> 2026-10-09 定稿：发给模型的内置提示词（system prompt 各段、工具描述、子代理身份、workflow 提示词、system-reminder 文案）中的产品名由 ZCode 统一改为 Mikiko。模型对自身的称呼会直接进入与用户的对话，属于事实上的对客可见面，随品牌清扫一并收敛。

## 范围（全部在 `apps/zcode-cli/packages/core/src/`）

**新会话 system prompt 主链**（`context/builder.ts` 拼装）：

- `sections/cli-prefix.ts`：首句身份 `You are Mikiko, an interactive coding agent`（所有非 workflow-actor 会话的第一段）。
- `sections/identity.ts`：`You are an interactive Mikiko agent…` 与 output-style 路径的 `…while using Mikiko's tools and instructions.`。
- `sections/desktop.ts`：桌面端附加段的 section name 与 header `# Mikiko Desktop Context`（仅 `presentationSurface === "zcode_desktop"` 时注入）。

**随请求发给模型的工具描述 / ToolEntry 标签**：`tool/handlers/read.ts`（video input limit）、`tool/handlers/read-session-context.ts`（描述与 reason）、`tool/handlers/agent.ts`（Task 别名 capability）。

**子代理身份**：`subagent/general-purpose.ts`（`You are an agent for Mikiko CLI`）、`subagent/explore.ts`（`You are Mikiko Explore…`）。

**其他模型可见内置文案**：`runtime/helpers/conversation.ts`（in-app browser 上下文块的 `## My request for Mikiko:` 标题）、`runtime/helpers/attachment-path-reference.ts`（附件拒绝理由）、`runtime/methods/workspace-generate-text.ts`（连通性探针）、`system-reminder/incoming-message.ts`（peer 会话消息引导）、`session-context/references.ts`（历史会话引用提示）、`workflow/expert/prompts.ts` 与 `workflow/scheduler/prompts.ts`（workflow 节点提示词）。

**注释同步**：源码注释中引用上述 prompt 原文的片段（`builder.ts`、`workflow-actor.ts` 等）随原文一起更新，避免注释与实现失真。

## 明确不改（沿用 `specs/mikiko-cloud/agent-endpoint-plan.md` 存量结论）

- `Zcode*`/`ZCode*` 类名、变量名、错误消息、诊断日志（技术受众，暂不重命名的存量决策）。
- 协议枚举与契约值：`zcode_desktop`（presentationSurface）、`x-zcode-bot-secret` 请求头、`window.zcode`、channel/route 名等小写技术标识。
- 用户可见 UI 文案已在前序品牌清扫中完成（i18n 无 ZCode 残留）。

## 验收场景

1. 新会话（CLI / 桌面）system prompt 首句为 `You are Mikiko, an interactive coding agent`，桌面端含 `# Mikiko Desktop Context`，全文无 `ZCode`。
2. Task/Agent 工具派发的子代理身份自称 Mikiko CLI / Mikiko Explore。
3. 发给模型的工具 schema、system-reminder、workflow 提示词中产品名均为 Mikiko。
4. 类名、日志、协议枚举不受影响（`pnpm typecheck` / `pnpm lint` 通过，无行为改动）。

## 生效链路（2026-10-09 实测踩坑）

源码改动**不会**立即体现在桌面会话：桌面 App（含 dev）的 agent 从构建产物启动——dev 用 `packages/desktop/bundled-agents/<platform>/glm/zcode.cjs`（`desktopRuntimeEnv.ts` 解析，候选只有 bundled-agents），安装版用 `Resources/glm/zcode.cjs`。改完 `apps/zcode-cli` 源码后必须：

1. 跑 `node scripts/build-desktop-agent-cli.mjs`（dev 只重建宿主平台）刷新 staging，否则旧文案静默残留——「改动没进去」会伪装成「代码没作用」（脚本注释里的既有教训）；
2. 存量 agent 进程仍持旧代码，新会话才会从新 bundle 拉起；必要时整体重启 host；
3. 安装版 App 需走 `bundle:desktop` 重新打包发版才更新；其余三个平台的 staging 拷贝由打包链自行重建。
