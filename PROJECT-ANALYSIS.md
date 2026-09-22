# ZCode 项目整体分析报告

> 分析日期：2026-09-21 · 仓库版本：3.14.0 · 分支：main（基线检查通过）
> 范围：全仓库 14 个 `packages/*` + `apps/zcode-cli` 子 workspace，约 63.8 万行 TypeScript（`scripts/count-lines.sh` 口径）

## 一句话结论

ZCode（v3.14.0，Apache-2.0）是一个**约 64 万行 TypeScript 的 AI 编程工作台 monorepo**，同一套代码支撑三个产品形态：Electron 桌面应用、浏览器 Web 工作台、终端 Agent CLI。架构成熟度相当高（六边形的 Agent 运行时、自研 VS Code 风格 RPC 框架、事件溯源会话、细粒度信任边界），但**测试覆盖接近于零、部分文件远超行数规范**，且当前克隆尚未安装依赖，所有校验命令无法执行。仓库 2026-09-21 刚开源，git 历史被压缩为 2 个提交。

## 1. 项目定位与规模

ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent 三种入口，本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

| 维度       | 数据                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| 代码规模   | 约 63.8 万行 TypeScript（`scripts/count-lines.sh` 口径）                    |
| 工作区     | 14 个 `packages/*` + `apps/zcode-cli`（内部又是含 16 个子包的子 workspace） |
| git 历史   | 2 个提交（开源时压缩），版本 3.14.0                                         |
| 运行时要求 | Node 24.14.0、pnpm 10.33.2（以 `mise.toml` 为准）                           |

代码量大头分布：

| 模块                                                    | 文件数（约）    | 说明                                   |
| ------------------------------------------------------- | --------------- | -------------------------------------- |
| `packages/ui`                                           | 1527            | 共享渲染层应用（639 tsx + 836 ts）     |
| `apps/zcode-cli`                                        | 1346            | Agent 运行时 + TUI + CLI（含生成代码） |
| `packages/services`                                     | 298             | 业务服务层                             |
| `packages/shared`                                       | 216             | 共享类型与协议                         |
| `packages/desktop`                                      | 265 + 1146 图标 | Electron 四进程桌面端                  |
| `packages/server`                                       | 48              | HTTP/WS 服务与远程部署                 |
| 其余（rpc / client / provider×2 / zcode-server-cli 等） | ~120            | 基础设施与小众工具包                   |

## 2. 整体架构

整个系统围绕一条核心链路组织：**UI 不直接持有业务逻辑，一切业务能力来自 Service 集合；Agent 是独立进程，通过 stdio 上的 JSON 行协议接入**。

```
┌─ 桌面 Renderer ─┐   ┌─ 浏览器/手机 ─┐        ┌─ TUI 终端 ─────┐
│  @zcode/ui      │   │  @zcode/web    │        │  @zcode/tui    │
└───────┬─────────┘   └───────┬────────┘        └───────┬────────┘
   MessagePort          WebSocket (/ws)              直接进程内
        │                   │                          │
┌───────▼───────────────────▼──────────────────────────▼────────┐
│  Service 层 (@zcode/services, 41 个服务, createLocalServices)   │
│  ·桌面: 每窗口一个 Host 进程 (utilityProcess.fork)              │
│  ·Web:   Hono HTTP+WS server (@zcode/server)                   │
│  ·远程:  SSH / WSL / Docker 部署 zcode-server 再桥接             │
└───────────────────────────┬────────────────────────────────────┘
                 stdio JSONL (zcode-protocol-v4)
┌────────────────────────────▼───────────────────────────────────┐
│  Agent 运行时 (apps/zcode-cli: core → bootstrap → cli)          │
│  事件溯源会话 (SQLite) · 工具系统 · 权限模型 · Vercel AI SDK 6    │
└─────────────────────────────────────────────────────────────────┘
```

### 关键架构设计

- **通信完全统一**。Electron MessagePort、浏览器 WebSocket、远程 stdio socket、TCP 全部适配为同一 `ISocket → SocketProtocol → ChannelServer → ProxyChannel` 管线（`packages/rpc`，自述为 "VS Code style IPC framework"，分 7 层实现，含连接级流控与断线重连的持久协议）。客户端拿到的永远是强类型 Service 代理。
- **信任边界做得细**。Web 端 WebSocket 默认是 `web-remote-replayable`（只读回放语义），桌面主机通过一次性 capability token 接入 `/ws/host` 成为 `desktop-continuous`（实时语义）；连接角色用内部 Symbol 传递，防止客户端自我提权（见 `packages/server/src/http.ts`、`packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`）。非桌面客户端还会被剥掉 Provider 写入能力。
- **桌面是四进程架构**：main（窗口/托盘/更新/遥测/嵌入式浏览器）+ 每窗口一个 Host 进程（承载本地 Service 集合与远程工作区连接注册表）+ scheduler（cron/闲时任务调度）+ renderer（薄壳，UI 主体来自 `@zcode/ui`）。Host 由 `utilityProcess.fork()` 拉起，renderer 与手机端都作为 attachment 挂到同一 Host。
- **Agent 是"被 spawn 的独立进程"**：桌面用 `ELECTRON_RUN_AS_NODE` 跑打包进资源的 `zcode.cjs`（`app-server --stdio`，这把包体积从 ~180MB 压到 ~16MB），开发态直接跑 monorepo 源码产物；远程场景则先把 server/agent 部署到远端再以 stdio socket 连接。协议为 LF 分帧的 JSON 行（zcode-protocol-v4，wire 版本 3），带 CRC32、分帧重组与 topic 级投递语义。

## 3. Agent 运行时（技术核心）

`apps/zcode-cli` 是自带独立 pnpm workspace 的子 monorepo，采用清晰的三层结构：

```
@zcode/cli（入口/命令路由）
  → @zcode/bootstrap（组装根 + 协议宿主 + V4 网关）
    → @zcode/core（纯运行时逻辑）
I/O 一律走 @zcode/adapters，接口定义在 @zcode/contracts（28 个 port）
```

- **会话是事件溯源的**：所有状态以 `SessionEvent` 追加到 SQLite（Node 内置 `node:sqlite`，非第三方依赖），经 `EventReducer` 归约为 `SessionProjection`，天然支持 resume / fork / rewind / 回放；全链路传播 `traceId / sessionId / turnId / toolCallId`。
- **工具系统完整**：文件（Read/Write/Edit）、Glob/Grep、Bash（约 20 个文件专门做只读命令判定簇）、Web（WebFetch/WebSearch）、Todo、AskUserQuestion、Subagent 调度（Agent/Task）、Skill、计划模式（EnterPlanMode/ExitPlanMode）、定时任务（CronCreate 一族 / OffPeak）、动态工作流（CreateWorkflow 一族）等，外加 MCP 工具接入（`mcp__<server>__<tool>`，支持 stdio/http/sse）。
- **Turn 状态机显式建模**：start → model request → streaming → schedule tools → permission → tool execution → complete，支持 pending input 队列（steering）与取消；核心 agent loop 面向长程任务，不按 tool call 次数硬停止。
- **权限模型**是五档协作模式（`plan | build | edit | yolo | auto`）+ 工具风险元数据（readOnly/destructive/sideEffectScope/riskLevel）+ 会话规则 + hooks 共同决策。
- **AI SDK 集中在唯一一处**：只有 `@zcode/adapters` 依赖 Vercel AI SDK 6（`ai`、`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/openai-compatible`，其中两个打了本地 patch）。模型 Provider 注册、配置叠加、内置 provider 签名分发在根仓库 `packages/provider` / `provider-node`。
- **TUI 不是 ink**：OpenTUI + React 19 + shiki，约 90 个 `app-*` 界面文件。

## 4. 其余模块速览

| 包                                    | 职责                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui`                         | 整个渲染层应用（非组件库）：v4 会话时间线、设置中心、插件商店（领域词汇见 `CONTEXT.md`）、终端（xterm）、Git 面板/git-graph、白板、命令中心（⌘K）、会话分享等；约 40 个 Zustand store、自研轻量 i18n（zh-CN/en-US 各 6000+ 行）、Tailwind v4 CSS-first 主题（light/dark/zai-light/zai-dark/system） |
| `packages/web`                        | 仅 17 个文件的薄入口：WebSocket 接入 + Web 平台 `IPlatformService` 降级实现 + OAuth 回调页 + 会话分享落地页；与桌面 renderer 共享几乎全部 UI                                                                                                                                                        |
| `packages/server`                     | Hono HTTP+WS 服务（默认 3030）、token 鉴权、一次性 host capability token、远程部署（SSH/WSL/Docker 三种 backend，含资产 CDN、缓存、部署锁、协议握手）                                                                                                                                               |
| `packages/zcode-server-cli`           | 远端 `zcode` 命令的安装/守护（supervisor）/自更新/系统服务注册管理器                                                                                                                                                                                                                                |
| `packages/shared`                     | 全部类型 + zod schema + 协议定义（zcode-protocol-v4：topic 分帧、CRC32、`continuous` 30ms / `replayable` 150ms 双档投递），纪律上禁运行时 IO                                                                                                                                                        |
| `packages/provider` / `provider-node` | 模型 Provider 平台无关领域层（registry/resolver/config overlay）与 Node 落地（配置文件仓库、内置 provider 作为带签名的 Release 分发，支持 Bundled/Active/Remote 三来源同步）                                                                                                                        |
| `packages/formal-proof`               | 产品行为状态空间枚举器：对对话产品的 compact/fork/goal/消息队列组合穷举全部状态与决策路径，d3 渲染可标注证明树；是质量工具，不在运行时链路                                                                                                                                                          |
| `packages/model-option-map`           | 受限 CEL（Common Expression Language 子集）方言的完整 tokenizer/parser/compiler，用于声明式计算模型选项（reasoningLevel、maxOutputTokens），零运行时依赖                                                                                                                                            |
| `packages/zcode-cua`                  | Computer Use 的 API 兼容占位包（纯预编译 JS + d.ts，无源码），此构建 fail-closed，所有运行时接口返回不可用                                                                                                                                                                                          |

服务层要点：`createLocalServices()`（`packages/services/src/node.ts`，~2700 行）是所有服务装配与 dispose 链的唯一组合根，HTTP / stdio / desktop host / 远程四种宿主共用。持久化为混合模式——SQLite 任务索引（`~/.zcode/v2/tasks-index.sqlite`）+ 加密 `credentials.json` + 各类文件仓库。41 个服务接口涵盖 Agent/Task/Session/File/Git/Terminal/OAuth/插件/技能/MCP 同步/订阅/分享/CUA 权限/跨窗口广播等。

## 5. 技术栈

| 层     | 选型                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 前端   | React 19.2、Vite 8、Tailwind CSS v4（CSS-first）、shadcn/radix、Zustand 5、SWR 2、Lexical、xterm、streamdown/shiki |
| 桌面   | Electron（electron-builder 26；mac dmg+zip / win nsis / linux AppImage+deb+rpm+pacman，签名与 notarize 两段式）    |
| 后端   | Hono + @hono/node-server / node-ws                                                                                 |
| 存储   | SQLite（Node 内置 `node:sqlite`）+ JSON/文件仓库混合；凭据加密存储                                                 |
| AI     | Vercel AI SDK 6（anthropic / openai / openai-compatible provider，含本地 patch）                                   |
| 工具链 | TypeScript 6.0、oxlint/oxfmt（Rust 系替代 ESLint/Prettier）、turbo、husky + lint-staged、release-it、knip          |

## 6. 工程化与治理

- 仓库有自觉的架构治理体系：`architecture-policy.yaml` 声明模块边界（`maxFileLines: 400`、`maxContractLines: 300`、禁止循环依赖、禁止深层导入），配套 `pnpm architecture:check`（pre-push 钩子含 lint + 架构检查）与受控上下文读取（`pnpm architecture:context <module-id>`）。
- `AGENTS.md` 为 AI 协作定下纪律：spec-first、单一状态所有者、协议改动同步 `packages/shared/src/zcode-protocol`、workspaceIdentity 身份隔离、日志分级规范等。
- `scripts/` 下 48 个构建维护脚本（bootstrap、桌面打包、SEA 构建、原生搜索工具、第三方声明生成等）。
- 第三方合规材料完整：`THIRD-PARTY-NOTICES.md` 近 2MB，`NOTICE.md` 声明功能与风险范围。
- 但治理处于早期阶段：策略文件里 15 个模块只有 `storage` 一个标记 `managed: true`，其余全是 `managed: false`（legacy 存量），且 `managedOnly: true` 意味着架构检查目前只实际覆盖这一个模块。

## 7. 当前状态与健康度（本次实测）

| 检查项                                       | 结果                                           |
| -------------------------------------------- | ---------------------------------------------- |
| `node scripts/check-workspace-freshness.mjs` | ✅ 通过，基线新鲜                              |
| `pnpm typecheck`                             | ❌ 无法执行：`node_modules` 缺失，`tsc` 不存在 |
| `pnpm lint`                                  | ❌ 无法执行：`oxlint` 不存在                   |
| `pnpm architecture:report`                   | ❌ 无法执行：找不到 `typescript` 依赖          |

- **依赖未安装是当前环境的第一事实**：要进入可开发状态需先跑 `pnpm bootstrap`（安装依赖 + 准备桌面运行资源 + 串行构建）。
- **一个环境警告值得注意**：当前 shell 使用的 pnpm 版本已不读取根 `package.json` 的 `pnpm.overrides` 和 `patchedDependencies` 字段（警告打印且这两个键被忽略）。仓库锁定的 pnpm 10.33.2 需通过 mise 激活，否则 React 版本 override（19.2.7）与三个依赖补丁（@arms/rum-electron、@ai-sdk/openai-compatible、@ai-sdk/anthropic）不会生效——直接 `pnpm install` 可能装出不符合预期的依赖树。
- git 状态干净，无未提交改动。

## 8. 主要风险与短板

1. **测试几乎为零（最大风险）**。全仓库只有 4 个测试文件（`packages/services/test/` 3 个 + `packages/ui/test/` 1 个，用 `node:test`），`apps/zcode-cli` 内部 1346 个文件、约 29 万行代码没有任何测试；E2E 基础设施钩子（istanbul 覆盖率插桩、`e2e-store-bridge`、隔离数据目录 env）齐全，但用例本体不在仓库中。对一个在规范里强调"行为改动先补测试、交互改动需要 E2E"的仓库来说，这是规范与现实的最大落差。
2. **超大文件与 400 行规范冲突普遍**。最大的 `zcodeTaskServiceAdapter.ts` 5737 行、`zcodeAgentService.ts` 5646 行、i18n 两个 locale 各 6000+ 行、`product-projection.ts` 5459 行、`browserGuestManager.ts` 4639 行；桌面 `main/index.ts` 与 `host/index.ts` 都带 `max-lines` 豁免注释。
3. **架构治理刚起步**：15 模块仅 1 个 managed，检查实际覆盖面很小。
4. **开源协作上下文薄**：历史只有 2 个提交，根目录无 CI 配置，外部贡献者难以从历史理解演进；`pnpm bootstrap`（含 Electron、原生依赖、可选远程资源）对新人不算轻量。

## 9. 总结与建议

这是一个**架构设计水准明显高于平均水平的 AI 编程工作台**：进程模型、RPC 抽象、协议双语义（实时/回放）、事件溯源会话、权限与信任边界都经过认真设计，模块职责划分清晰，工程化脚本体系完备。它的短板集中在**质量保障体系**（测试、文件规模管控、架构检查覆盖）而非架构本身。

若要在此基础上长期开发，建议按优先级：

1. 通过 mise 激活正确工具链（Node 24.14.0 / pnpm 10.33.2），完成 `pnpm bootstrap`，跑通 `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check` 建立基线。
2. 为核心纯逻辑补单测：协议编解码（`packages/shared/zcode-protocol-v4` 的 wire-codec）、`EventReducer`、RPC 序列化层、`model-option-map` 的 CEL 求值——这些都是无 IO、高杠杆的测试点。
3. 逐步拆分 5000+ 行的巨型文件，并将更多模块纳入 `managed: true` 治理。
4. 补充 CI（typecheck + lint + 架构检查 + 存量测试），让开源协作有可验证的门禁。

---

_报告由代码库静态分析生成：4 个并行探索 agent 分别覆盖桌面端、Agent CLI、UI/Web、后端与服务层，规模数据来自 `scripts/count-lines.sh` 与 `wc -l` 估算，健康度结论来自实际执行 `check-workspace-freshness` / `typecheck` / `lint` / `architecture:report` 的真实输出。_
