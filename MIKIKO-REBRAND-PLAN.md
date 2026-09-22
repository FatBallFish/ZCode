# ZCode → Mikiko 品牌更名全量方案

> 版本：v2.0（2026-09-22，基于 v1.0 盘点 + 9 项决策更新；代码基线 main @ 872ad96）
> 目的：将品牌从 ZCode 更名为 Mikiko，并把产品定位调整为「全新品牌、全新账号体系」。
> 本文档是**唯一清单来源**，执行时按阶段勾选验收项，避免遗漏。
> 盘点口径：`packages/*`、`apps/zcode-cli`、`scripts/`、根配置（排除 node_modules/dist/out 构建产物）。

---

## 决策记录（v2.0，已确认）

| #   | 决策                                                                                                                                                                            | 落点                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D1  | **不做数据迁移，按全新品牌处理**（不迁移 + 首启引导）                                                                                                                           | §4.1 重写：删除全部迁移逻辑，localStorage/凭据/数据根均全新 |
| D2  | **深链保留 `zcode://`**，zcode 登录/深链降级为三方供应商支持；**新增 `mikiko://`** 用于新品牌链路                                                                               | §4.2                                                        |
| D3  | **出网请求头双套**：新增 Mikiko 头；ZCode 头保留，仅在 ZCode OAuth 模式（z.ai/bigmodel 账号供应商）下使用                                                                       | §4.4                                                        |
| D4  | `@zcode/*` 包 scope **确认不动**                                                                                                                                                | §5                                                          |
| D5  | 第三方品牌（Z.ai/BigModel/GLM 等）**明确不改**                                                                                                                                  | §5                                                          |
| D6  | **RPC header 可安全改名**：与 UA 不同，它只在本仓库 client/server 间收发、无第三方依赖；执行 `x-zcode-*` → `x-mikiko-*` + 一个版本周期双读（非永久双套）                        | §4.3                                                        |
| D7  | **CUA Helper：保留 `ZCODE_CUA_*` 原名**（调查结论：Helper 源码不在仓库，官方 Helper 有签名互验，开源构建 CUA 本就端到端 fail-closed，改名零收益且切断未来接回可能）             | §4.5                                                        |
| D8  | **自有域名/外部链接暂保留**；后期新增 **Sub2API 账号体系**（内置默认站点 + 用户自配第三方站点、OAuth/密码登录、密钥管理与换绑分组、余额/订阅/用量查询、密钥切换即时换模型路由） | §4.6、§7（新功能设计）                                      |
| D9  | **Logo 资产**：先出资源清单文档（见 [MIKIKO-BRAND-ASSETS.md](MIKIKO-BRAND-ASSETS.md)），现成资源兜底，缺失项列清单待设计                                                        | §2.3 引用                                                   |

---

## 0. 命名规范映射表

| 层面              | 旧值                                                                                            | 新值                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 显示名（UI/App）  | ZCode                                                                                           | Mikiko                                                                                |
| 显示名变体        | ZCode Preview / ZCode Dev                                                                       | Mikiko Preview / Mikiko Dev                                                           |
| 小写标识          | zcode                                                                                           | mikiko                                                                                |
| 环境变量前缀      | `ZCODE_`                                                                                        | `MIKIKO_`（**例外**：`ZCODE_CUA_*` 保留，见 D7；`ZAI_*`/`BIGMODEL_*` 第三方配置保留） |
| Vite 注入前缀     | `VITE_ZCODE_`                                                                                   | `VITE_MIKIKO_`（`VITE_ZAI_*` 保留）                                                   |
| 数据根目录        | `~/.zcode`                                                                                      | `~/.mikiko`（**全新目录，无迁移**）                                                   |
| 主题名            | `zai-light` / `zai-dark`                                                                        | `mikiko-light` / `mikiko-dark`（无旧值迁移）                                          |
| localStorage 前缀 | `zcode-` / `zcode:`                                                                             | `mikiko-` / `mikiko:`（无旧值迁移）                                                   |
| 深链协议          | `zcode://`                                                                                      | `zcode://` 保留（仅 OAuth 回调）+ **新增 `mikiko://`**（share/workspace 等新链路）    |
| 桌面 appId        | `dev.zcode.app`                                                                                 | `dev.mikiko.app`                                                                      |
| Cookie            | `zcode_lite_token`                                                                              | `mikiko_lite_token`                                                                   |
| RPC header        | `x-zcode-*`                                                                                     | `x-mikiko-*`（双读一个版本周期，见 §4.3）                                             |
| 出网请求头        | `User-Agent: ZCode/*` 等单一套                                                                  | **双套**：Mikiko 头（默认）+ ZCode 头（仅 z.ai/bigmodel 账号供应商）                  |
| **不改**          | `@zcode/*` 包 scope、`ZCode*` 代码符号、`zcode-protocol` 模块名、`ZCODE_CUA_*`、error code 常量 | D4/D7/§5                                                                              |
| **不改**          | Z.ai / BigModel / GLM / Kimi 等第三方品牌与域名                                                 | D5                                                                                    |

**Slogan**：README 定位句 `ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent` → `Mikiko 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent`（或按新品牌定位重写，落点见 §2.1）。

---

## 1. 分层改名策略

| 层                    | 内容                                                                                                       | 策略                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **P0 用户可见层**     | Logo 资产、i18n 文案、Slogan、App 身份（appId/productName/托盘/About/安装器）、主题品牌、文档              | **必改**（资产用现成资源兜底，见 D9） |
| **P1 本地配置身份层** | 环境变量（`ZCODE_*`→`MIKIKO_*`，`ZCODE_CUA_*` 除外）、数据目录 `~/.zcode`→`~/.mikiko`、localStorage/cookie | **必改，无迁移逻辑**（D1：全新品牌）  |
| **P2 协议与兼容层**   | 深链（双协议）、RPC header（改名+双读）、出网 UA（双套）、CUA（保留）                                      | **按 D2/D3/D6/D7 决策执行**           |
| **P3 不动层**         | `@zcode/*` scope、代码符号、error code、`.agents/` 目录、`ZCODE_CUA_*`、第三方品牌域名                     | **不改**（§5）                        |

> 工作量参考（品牌更名部分）：P0 ≈ 3–5 人日（不含正式 Logo 设计）；P1 ≈ 1 人周（无迁移后比 v1.0 估算减半）；P2 ≈ 2–3 人日；Sub2API 新功能另计（§7，4–6 人周）。

---

## 2. P0：用户可见层清单

### 2.1 Slogan 与产品描述文案

| 位置                                                                                   | 当前内容                                           | 动作                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `README.md` L1/L4/L13/L17、`README.en.md` L1/L13                                       | 标题、logo alt、定位句、"Web / ZCode 命令行版"     | 全部替换（CLI 命令名 `zcode` 的替换见 §3.3）                                             |
| `packages/ui/src/i18n/locales/zh-CN.ts`（88 处）/ `en-US.ts`（91 处）                  | 详见模块表                                         | 全部替换（含 key 名含 zcode 的条目）                                                     |
| `apps/zcode-cli/packages/i18n/src/locales/{zh-CN,en-US}.ts`（各 4 处）                 | `zcode ${version}` 用法头、`正在启动 ZCode…`       | 替换                                                                                     |
| `packages/web/src/share/ConversationShareLandingPage.tsx`（约 14 处，硬编码不走 i18n） | `ZCode 会话分享`、`去 ZCode 继续`、`下载 ZCode` 等 | 替换（建议顺手迁入 i18n）；深链 `zcode://share/import` → `mikiko://share/import`（§4.2） |

**i18n 中含 ZCode 的 key 模块表**（zh-CN.ts 行号为参考）：

| 模块                   | 代表 key（行号）                                                                                                                                            | 备注                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| welcome/login          | `welcome.title`(500)、`login.title/description`(506-507)                                                                                                    | 首屏；登录页将随 §7 Sub2API 体系改版                                 |
| logout                 | `logout.confirm.title`(547)                                                                                                                                 |                                                                      |
| onboarding             | `onboarding.dialog.title` 等(3857-3862)                                                                                                                     | **首启引导落点（D1）**                                               |
| occupationOnboarding   | 3 条(13/52/62)                                                                                                                                              |                                                                      |
| startup                | `startup.global.*`、`startup.errors.*` 约 8 条(66-77)                                                                                                       |                                                                      |
| about/update           | `titleBar.menu.help.about`(1121)、`forceUpdate.title`(1173)                                                                                                 |                                                                      |
| share                  | `conversationShare.permission/import.*`(188/379)                                                                                                            |                                                                      |
| 聊天输入               | `chat.placeholder.newTask(Mobile)`(3968-3969)                                                                                                               |                                                                      |
| 电脑控制               | `chat.toolbar.computerUse.*`、`cuaPermission.*` 约 12 条                                                                                                    | **建议新增品牌期默认隐藏 CUA 入口**（开源构建 fail-closed，见 §4.5） |
| 闲时/资源              | `offPeak.keepAwakeBanner`(5783)、`resourceManager.appUsage`(5411)                                                                                           |                                                                      |
| 设置                   | `settings.zcodeInteractionBehavior*`、`settings.dataRoot*`、`settings.mcp.*` 等约 40 条                                                                     |                                                                      |
| feedback               | `feedback.submit.template.section.copyErrorHeading`(5640)                                                                                                   |                                                                      |
| **key 名本身含 zcode** | `zcode.unavailable`、`zcode.error.*` 约 20 条(5364-5394)、`settingsSync.agent.zcode`、`settings.commands.source.zcodeAgent`、`sidebar.usage.plan.zcodeMcp*` | **改 key 必须同步代码引用**，放最后统一做                            |

### 2.2 App 身份与安装器

| 位置                                                                           | 字段                                                               | 当前值                                                                | 新值                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/desktop/scripts/desktop-product-identity.mjs`                        | 产品身份唯一权威                                                   | `dev.zcode.app` / `ZCode` / `zcode`(linux) / `cn.aminer.zcode`(AUMID) | `dev.mikiko.app` / `Mikiko` / `mikiko` / `cn.mikiko.app`（AUMID 按自有域名定） |
| `packages/desktop/src/main/desktopRuntimeEnv.ts` L61-63                        | `runtimeApplicationName`（userData 目录名 + ARMS 应用名 + 进程名） | `ZCode` / `ZCode Preview` / `ZCode Dev`                               | `Mikiko` / `Mikiko Preview` / `Mikiko Dev`                                     |
| `packages/desktop/electron-builder.config.js` L459-463                         | homepage / author / maintainer                                     | `https://zcode.z.ai`、`ZCode <dev@zcode.z.ai>`                        | **D8：暂保留**（域名未定），加 `// TODO(mikiko): 待自有域名` 标记              |
| 同上 L238/281/290/701-703/736-738                                              | artifactName、`.app` 兜底名、linux `Icon=zcode`、DMG 资产          | —                                                                     | 随 identity 自动 + 手查兜底串                                                  |
| 同上 L649-656                                                                  | protocols                                                          | `schemes: ["zcode"]`                                                  | **改为 `["zcode", "mikiko"]` 双注册**（§4.2）                                  |
| `packages/desktop/src/main/about.ts` L55/L62-86                                | About 名称与版权                                                   | `ZCode Desktop App`、`Copyright © ZCode`                              | 改                                                                             |
| `packages/shared/src/desktopMenu.ts` L90-163                                   | 菜单/托盘文案                                                      | `关于 ZCode`、`tray.tooltip: "ZCode"` 等                              | 改（key `tray.menu.openZCode` 同步引用）                                       |
| `packages/desktop/build/installer.nsh`                                         | NSIS 文案（79 处，对话框 L529-550）                                | `ZCode-installer.log`、`.zcode` 目录提示                              | 对话框必改；数据目录提示改 `.mikiko`                                           |
| `packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts` L5-10       | 右键菜单                                                           | `ZCode.OpenInZCode`、`在ZCode中打开`                                  | 改                                                                             |
| `packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts` L11-14/112-113 | desktop entry                                                      | `zcode.desktop`、`Name=ZCode`、`Icon=zcode`                           | 改（沿用归属标记机制清理旧 entry）                                             |
| `packages/zcode-cua/broker-helper-constants.js`                                | Helper 应用名/bundle id                                            | `ZCode Computer Use.app`、`dev.zcode.cua-helper`                      | **D7：不改**                                                                   |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx` L36                          | `PRODUCT_NAME`                                                     | `"ZCode"`                                                             | `"Mikiko"`                                                                     |
| `packages/ui/src/WorkspaceSidebarFooter.tsx` L67                               | 侧栏品牌 fallback                                                  | `return "ZCode"`                                                      | 改                                                                             |

### 2.3 Logo / 图标资产

**完整规格清单、现成资源兜底方案与待设计项见 [MIKIKO-BRAND-ASSETS.md](MIKIKO-BRAND-ASSETS.md)（D9）**。要点：

- 二进制资产（`public/logo/icons/` 全套、`packages/desktop/build/` 主图标/安装器图标/Linux hicolor/DMG 背景、favicon）→ **暂用 ZCode 现成资源兜底**，待设计稿到位后按清单替换；
- 代码内 SVG（`ZCodeAboutLogo.tsx` 图形标+wordmark、`aboutWindow.ts` 内联、`web/index.html` loading 壳）→ **可立即替换**为兜底版（M 单字母图形标 + `<text>` wordmark，SVG 源码见资产文档）；
- provider 图标（`logo-zai*.svg` 等）→ 第三方品牌，保留；`WindowsTopLeftLogo.tsx` 对 `logo-zai.svg` 的产品 logo 挪用要解除。

### 2.4 主题品牌（zai-_ → mikiko-_）

| 位置                                                                | 内容                                                                                                                  | 动作                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/ui/src/useTheme.ts`                                       | `Theme` 枚举、`STORAGE_KEY="zcode-theme"`、`data-zcode-browser-theme-surface`、class `theme-zai-*`、默认 `"zai-dark"` | 改 `mikiko-*`；**D1：无旧值迁移**（新键新值直接用） |
| `packages/ui/src/styles.css` L461+/606+                             | `.theme-zai-light/dark` 品牌变量                                                                                      | class 名改；色板调整随设计稿                        |
| 引用 zai 主题名的 21 个文件                                         | `SettingsPage.tsx`、`WorkspaceSidebar*.tsx`、`store/index.ts`、web `index.html`/`webThemeSeed.ts` 等                  | 全量同步（全局替换 + 逐文件 review）                |
| i18n key `settings.themeMode.zai-*`、`sidebar.settings.theme.zai-*` | key 名含 zai                                                                                                          | key 改名 + 同步引用                                 |

### 2.5 遥测身份

| 位置                                                              | 内容                               | 动作           |
| ----------------------------------------------------------------- | ---------------------------------- | -------------- |
| `packages/desktop/src/main/appARMSBootstrap.ts` L170-184          | ARMS `app.name`                    | 随 §2.2 自动改 |
| `packages/desktop/src/main/localTtftExporter.ts` L39              | `service.name: "zcode-local-ttft"` | 改             |
| `packages/desktop/src/main/desktopStabilityTelemetry.ts` L704-707 | `zcode-host`/`zcode-agent` 前缀    | 随进程名自动   |

---

## 3. P1：环境变量 / 存储键 / 路径清单

### 3.1 环境变量总览（约 115 个 `ZCODE_*` + 8 个 `VITE_*`）

定义权威：`packages/shared/src/runtimeEnv.ts`（ENV）、`packages/shared/src/env.ts`、`packages/shared/src/zcodeEndpoint.ts`；主→Host 注入：`packages/desktop/src/main/desktopRuntimeEnv.ts`（DRE）；远端注入：`packages/server/src/remote/connect.ts`（CONN）。

**改名规则：`ZCODE_` → `MIKIKO_`，例外见组 H。按组原子执行：**

| 组             | 变量（代表）                                                                                                                                                                                                                                                                                                                                                                                       | 原子同步范围                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A 路径组       | `ZCODE_DATA_BASE_DIR`、`ZCODE_HOME`、`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE(_BUNDLED)`、`ZCODE_DESKTOP_HOME_DIR`、`ZCODE_DESKTOP_USER_DATA_DIR/SESSION_DATA_DIR/APPLICATION_NAME`、`ZCODE_LOG_DIR`、`ZCODE_REMOTE_ASSET_CACHE_DIR`、`GLM_BINARY_PATH`（建议改 `MIKIKO_AGENT_BINARY_PATH`）                                                                     | 写/读端成对改；`ZCODE_DATA_BASE_DIR` 三处（paths.ts:11、desktopRuntimeEnv.ts:556、zcode-server-cli paths.ts:24） |
| B 服务端点组   | `ZCODE_BASE_URL`、`ZCODE_ENDPOINT_ORIGIN`、`ZCODE_CDN_BASE_URL`、`ZCODE_DIST_BASE_URL`、`ZCODE_DEPS_BASE_URL`、`ZCODE_REMOTE_ASSET_CDN_BASE_URL`、`ZCODE_SERVER_RELEASE_MANIFEST_URL`、`ZCODE_TELEMETRY_REPORT_ENDPOINT`、`ZCODE_ARMS_RUM_ENDPOINT`、`ZCODE_FEEDBACK_API_BASE`、`ZCODE_CONVERSATION_SHARE_WEB_URL`                                                                                 | 本地 + CONN:53-68 `REMOTE_RUNTIME_ENV_KEYS` 白名单 + 远端 server 读取点三方一致                                  |
| C 进程间组     | `ZCODE_APP_VERSION`、`ZCODE_PROCESS_LABEL`、`ZCODE_RUNTIME_ENV`、`ZCODE_HTTP_PROXY/NO_PROXY`、`ZCODE_AGENT_SERVER_COMMAND/ARGS_JSON/CWD`、`ZCODE_AGENT_CA_CERT`、`ZCODE_TOOL_ENV_PASSTROUGH_JSON`→`PASSTHROUGH_JSON`、`ZCODE_LARK_CLI_BINARY`、`ZCODE_DYNAMIC_WORKFLOW_MODE`、`ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED`、`ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY`、`ZCODE_REMOTE_HTTP_PROXY/NO_PROXY` | DRE 写 ↔ host/agent 读；遥测类注意 ENV:278-284 的 `ZCODE_TELEMETRY_` **前缀匹配函数**同步改                      |
| D 服务器组     | `ZCODE_SERVER_ID/NAME/TOKEN/WORKSPACE/HOST/AUTH_TOKEN`、`ZCODE_SERVER_RUNTIME_ROOT`（内嵌远端命令字符串 CONN:365）、`ZCODE_WEB_STATIC_ROOT`                                                                                                                                                                                                                                                        | client/server 两侧原子；`.cmd` 启动器模板内嵌旧名随 release 重发                                                 |
| E 构建打包组   | `ZCODE_ENV`（含编译期 `__ZCODE_ENV__`）、`ZCODE_TARGET_OS/ARCH`、`ZCODE_COMMIT`、`ZCODE_SKIP_*`、`ZCODE_AUTO_UPDATE_DEV(_VERSION)`、`ZCODE_UPDATE_FEED_URL`、`ZCODE_DESKTOP_AGENT_*` 等约 20 个                                                                                                                                                                                                    | scripts + electron-builder + DRE，进程内低风险                                                                   |
| F E2E/调参组   | `ZCODE_DEBUG`、`ZCODE_E2E_*`（8）、`ZCODE_OFFPEAK_MOCK*`（10）、`ZCODE_MODEL_RETRY_*`（4）等                                                                                                                                                                                                                                                                                                       | 低风险；`.vscode/launch.json`、CI 脚本同步                                                                       |
| G Vite 注入    | `VITE_ZCODE_BASE_URL`、`VITE_ZCODE_E2E_STORE_BRIDGE`、`VITE_ZCODE_ENDPOINT_ORIGIN`、`VITE_CODING_PLAN_WEBVIEW_ORIGIN`、`VITE_REWARDS_WEBVIEW_ORIGIN`、`VITE_WEB_REMOTE_CONTROL_*`                                                                                                                                                                                                                  | 同步 `packages/web/vite.config.ts` define 与 `import.meta.env` 读取点                                            |
| **H 保留不改** | **`ZCODE_CUA_*` 全部（D7）**；`ZAI_OAUTH_*`、`ZAI_BUSINESS_*`、`BIGMODEL_*`（第三方配置）；`ZCODE_*` error code 常量约 15 个（错误码契约）                                                                                                                                                                                                                                                         | —                                                                                                                |

### 3.2 本地文件与目录身份（`.zcode` 字面量全仓 570 处 / 40+ 文件）

| 标识                                                                    | 定义位置                                                                                                                                                                   | 动作（D1：无迁移）                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `~/.zcode` → `~/.mikiko`                                                | `services/src/paths.ts:43-45`                                                                                                                                              | 直接改默认值；不写迁移代码                                                                                                   |
| `ZCODE_HOME` 兜底 `~/.zcode`                                            | `desktopRuntimeEnv.ts:498`、CLI `provider-runtime-env.ts`                                                                                                                  | 同步改 `~/.mikiko`                                                                                                           |
| `v2/` 子结构（setting/credentials/sessions/tasks-index/runtime）        | `paths.ts:53-224`                                                                                                                                                          | 路径前缀随数据根变；文件名不含品牌可不改                                                                                     |
| `~/.zcode/cli/`                                                         | `apps/zcode-cli/.../file-config.adapter.ts:62`、`contracts/src/config/index.ts:303`                                                                                        | → `~/.mikiko/cli/`                                                                                                           |
| `~/.zcode/server`（远端 server 根）                                     | **三处原子**：`server/src/remote/deployShared.ts:7`、`connect.ts:365/391`（含 `zcode-server.cjs` 产物名）、`zcode-server-cli paths.ts:26-28`（`basename===".zcode"` 反推） | → `~/.mikiko/server`，与 3.1-D 组一起改                                                                                      |
| workspace 级 `.zcode/` 目录                                             | `skillsService.ts:74`、`hooksService.ts:61`、`workspace-hook-config.ts`                                                                                                    | **决策（D1 延伸）**：新品牌只写读 `.mikiko/`；`.zcode/` 不做兼容读取（完全新品牌）；`.agents/` 跨工具惯例目录**永不改**      |
| Windows 禁止目录 `Program Files\ZCode`                                  | `paths.ts:116-119`                                                                                                                                                         | 随安装目录名同步（新旧都要挡）                                                                                               |
| 命名管道 `\\.\pipe\zcode-server-{hash}`                                 | `zcode-server-cli paths.ts`                                                                                                                                                | → `mikiko-server-`，cli/server 两侧原子                                                                                      |
| `~/.zcode/computer-use/`（CUA）                                         | `node.ts:1806-1816`                                                                                                                                                        | **D7：保留 `.zcode` 布局**（与 Helper 生态对齐）                                                                             |
| storageCatalog 白名单前缀                                               | `services/src/storage/domain/storageCatalog.ts:100-145`                                                                                                                    | 随目录结构同步                                                                                                               |
| 打包产物 `glm/zcode.cjs`、`zcode-server.cjs`、`.zcode-install-manifest` | electron-builder、CONN:391                                                                                                                                                 | 改名影响 CDN 路径与远端启动命令，与 D 组原子（**D8 注：CDN 路径暂保留 zcode 命名空间，产物名先不改**，避免远程资产下载断链） |
| `ZCODE_CREDENTIAL_SECRET`                                               | `credentialCipherProvider.ts:9`                                                                                                                                            | 改 `MIKIKO_CREDENTIAL_SECRET`（D1 无旧密文，安全）                                                                           |

### 3.3 CLI 可执行名（`zcode` → `mikiko`）

涉及：`apps/zcode-cli/packages/cli` bin 名与 help、根 `scripts/build-zcode.mjs` 产物、`install.sh`/`latest.json`、README 安装章节。三方（bin 名、构建脚本、安装脚本）一致。

### 3.4 浏览器/Web 存储键（约 85 个，D1：全部直接改，无迁移）

| 类别                  | 键（代表）                                                                                                                                                                                          | 策略                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Cookie                | `zcode_lite_token` → `mikiko_lite_token`（`server/src/http.ts:184,218-231`）                                                                                                                        | 直接改                                               |
| 登录态双端键          | `zcodejwttoken` → `mikikojwttoken`：web localStorage（`browserOAuthCredentialRepo.ts:13`）≡ desktop credentials.json（`remoteWorkspaceServiceCollection.ts:82`、`codingPlanEmbeddedWebview.ts:61`） | **两处原子改**（新品牌无旧值）                       |
| 偏好/缓存（约 55 个） | `zcode-theme`、`zcode-locale-preference`、`zcode-v4-*`、`zcode-task-snapshot-cache:v1` 等                                                                                                           | 批量改前缀                                           |
| DOM 事件（约 25 个）  | `zcode:workspace-path-open-request` 等                                                                                                                                                              | dispatch/listener 成对改                             |
| window 全局（E2E）    | `__zcodeSessionActivity` 等                                                                                                                                                                         | 与 e2e 用例同步                                      |
| MCP source 持久值     | `"zcodeagentmcp"`、`"zcode"`（`mcpSettingsShared.ts:3,26`）                                                                                                                                         | → `"mikikoagentmcp"`、`"mikiko"`（新写入；不读旧值） |

---

## 4. P2：协议与兼容层（按决策执行）

### 4.1 数据策略（D1：全新品牌，不迁移）

- **删除 v1.0 中全部迁移设计**：无 `~/.zcode` 检测/复制、无 localStorage 旧键读取、无 `ZCODE_CREDENTIAL_SECRET` 旧名兼容。
- 首启体验 = 现有 welcome/onboarding 流程改名直出；登录页以 **Sub2API 账号体系为主**（§7），Z.ai/BigModel OAuth 降级为「第三方供应商」入口（设置 → 模型供应商里添加）。
- 用户的官方 ZCode 与 Mikiko **并存互不影响**（不同 appId、不同 `~/.` 目录、不同 userData）。

### 4.2 深链协议（D2：双协议）

| 协议                                             | 用途                                                          | 动作                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zcode://oauth/callback`                         | z.ai/bigmodel OAuth 回调（redirect_uri 注册在第三方，不可改） | **保留**；仅在用户添加 Z.ai/BigModel 账号供应商时走到                                                                                                                               |
| `zcode://share/import`、`zcode://workspace/open` | 分享导入、Finder/浏览器打开工作区                             | **迁移到 `mikiko://`**：`conversationSharePreviewClient.ts:73`、`shared/platform.ts:678`、`desktopFinderOpenFolderWorkflow.ts:25`、`desktopOAuthDeepLink.ts:281` 同步               |
| electron-builder protocols                       | `schemes: ["zcode"]`                                          | → `["zcode", "mikiko"]` 双注册；`desktopOAuthDeepLink.ts:409` setAsDefaultProtocolClient 两协议都注册；handler 按 scheme 分流（mikiko:// 走新分支，zcode:// 仅放行 oauth/callback） |
| Web 分享页「继续使用」按钮                       | `zcode://share/import`                                        | → `mikiko://share/import`（旧 `zcode://` 链接自然失效，符合全新品牌定位）                                                                                                           |

### 4.3 RPC header 与远端协议（D6：改名 + 双读窗口）

- `x-zcode-rpc-client-mode`、`x-zcode-rpc-host-capability`（`shared/src/channels.ts:496-498` 单一定义源）→ 改为 `x-mikiko-*`。
- **评估结论**：这两个 header 只在本仓库的 client（desktop/web）与本仓库部署的 zcode-server 之间收发，**不出网、不依赖 z.ai、与 OAuth 模式无关**——因此不需要像 UA 那样永久双套，一次改名 + 兼容窗口即可。
- 执行：发送端发新名；接收端（`packages/server`、`zcode-server-cli`）**双读新旧名一个版本周期**（应对远端机器上还跑着旧版 server 的场景）；同时 bump `SERVER_REMOTE_PROTOCOL_VERSION`（`shared/src/server-remote.ts:3`）并在握手中携带 `productName` 能力标记，第二个版本删旧名读取。

### 4.4 出网请求头（D3：双套，按供应商模式选择）

改造点：`packages/shared/src/zcode-source-headers.ts`、`apps/zcode-cli/packages/bootstrap/src/model-config.ts:57-63`（两处生成点）。

| 模式                                                                                                    | 请求头                                                                                                                                | 说明                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **ZCode OAuth 模式**（provider family = zai/bigmodel 账号供应商，含官方 Coding Plan 网关 `ultra` 转发） | 保留现套：`User-Agent: ZCode/<ver>`、`X-ZCode-App-Version`、`X-Title: Z Code@*`、`HTTP-Referer: zcode.z.ai`                           | 官方网关可能按此统计/鉴权，不动                   |
| **Mikiko 默认模式**（其余全部供应商：API Key 模板、个人自定义、**Sub2API**）                            | 新套：`User-Agent: Mikiko/<ver>`、`X-Mikiko-App-Version`、`X-Title: Mikiko@<surface>`、`HTTP-Referer: <自有域名，未定前不发 Referer>` | 选择逻辑放在 header 构造处按 provider family 分支 |

### 4.5 CUA / Computer Use（D7：保留，建议隐藏入口）

调查结论（证据见 v2.0 盘底）：

- Helper（`ZCode Computer Use.app`，Node SEA 二进制）**源码不在本仓库**，由官方 CI 独立签名/notarize 后分发；开源构建不打包、不下载。
- `packages/zcode-cua` 占位包全表面 fail-closed；即使本机装有官方 Helper，其 `--launcher-pid` **签名互验**会拒绝非 ZCode 签名进程，Mikiko 构建无法使用。
- 因此：`ZCODE_CUA_*` env、`broker-helper-constants.js` 的应用名/bundle id、`~/.zcode/computer-use` 布局**全部保留原名**（改名零收益，且保留未来拿到 Helper 源码后低成本接回的可能）。
- **附带动作**：Mikiko 品牌期在 UI/设置中默认隐藏 CUA 入口（`ui/src/lib/cuaComposerEntryState.ts` 加产品开关，默认 off），避免用户看到永远失败的功能。

### 4.6 自有域名与外部链接（D8：暂保留 + 后期 Sub2API）

| URL                                                                    | 位置                                        | 动作                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `https://zcode.z.ai`（API 网关/分享回调/更新 manifest）                | `shared/src/zcodeEndpoint.ts:3`             | **暂保留**（ZCode OAuth 模式依赖）；加 TODO 标记                                         |
| `https://cdn-zcode.z.ai/...`（远程资产、插件市场）                     | `remoteCdn.ts`、`plugin-marketplaces.ts:37` | **暂保留**；配套：打包产物名 `zcode-server.cjs` 等本期不改（§3.2），避免远程资产下载断链 |
| `https://zcode.z.ai/docs`、分享下载页                                  | `productDocs.ts:2`、share 落地页            | **暂保留**，加 TODO                                                                      |
| 飞书社群/Discord/反馈表单                                              | `config/default.json:2-6`、README           | **暂保留**，加 TODO（后期换 Mikiko 自有）                                                |
| 第三方（`chat.z.ai`、`api.z.ai`、`open.bigmodel.cn`、OAuth client_id） | `zcodeEndpoint.ts`                          | **永不改**（D5）                                                                         |

---

## 5. P3：明确不改清单（及理由）

| 项                                                                             | 理由                                   |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| `@zcode/*` 包 scope（约 1263 文件 import 链）                                  | D4 确认不动；用户不可见，二期 codemod  |
| `ZCode*` 类型/函数符号                                                         | 代码符号，不可见                       |
| `zcode-protocol`、`zcode-protocol-v4` 目录/模块名                              | 代码组织；协议 payload 无 zcode 字面量 |
| `ZCODE_CUA_*` 全部 env、`ZCode Computer Use.app` 常量、`~/.zcode/computer-use` | D7（§4.5 调查结论）                    |
| `ZCODE_*` error code 常量（约 15 个）                                          | 错误码契约                             |
| `.agents/`、`.agents/skills`                                                   | 跨工具行业惯例                         |
| Z.ai / BigModel / GLM / Kimi 等第三方品牌、域名、模型名、provider 图标         | D5 第三方知识产权                      |
| `installer.nsh` 纯日志行                                                       | 随目录联动即可                         |

---

## 6. 执行计划

| 阶段                | 内容                                                                                               | 验证                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **S0 准备**         | 按 [MIKIKO-BRAND-ASSETS.md](MIKIKO-BRAND-ASSETS.md) 铺兜底资产；确定 appId/AUMID                   | 兜底资产生效                                                  |
| **S1 P0 静态替换**  | §2.2 App 身份 → §2.3 兜底资产 → §2.1 文案 → §2.4 主题 → §2.5 遥测 → §4.5 CUA 入口隐藏              | 双端界面走查（欢迎/登录/About/托盘/设置/主题/分享页/TUI）     |
| **S2 P1 env+存储**  | §3.1 按组原子改（A→C→B→D→E/F/G，跳过 H 组）→ §3.2 路径 → §3.3 CLI 命名 → §3.4 存储键（无迁移直改） | 全链路回归：agent spawn、web 模式、远程工作区、登录、凭据加密 |
| **S3 P2 协议**      | §4.2 双深链 → §4.3 RPC header+双读 → §4.4 UA 双套                                                  | OAuth（z.ai）、分享导入（mikiko://）、远程 server 新旧混连    |
| **S4 Sub2API 功能** | 按 §7 设计分四个里程碑 M1–M4                                                                       | §7.6 验收                                                     |
| **S5 打包验证**     | `pnpm build`、`bundle:desktop`、`build:zcode`；安装/卸载、与官方 ZCode 并存、双深链点击、右键菜单  | DMG/NSIS/AppImage 走查                                        |
| **S6 收尾扫描**     | 下方扫描命令                                                                                       | 残留归零或标记「有意保留」                                    |

**复核扫描命令**（每阶段结束执行；残留应只剩 §5 白名单）：

```bash
grep -rn "ZCode" --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.json" \
  packages apps scripts config README*.md --exclude-dir=dist --exclude-dir=out | grep -v "@zcode"
grep -rn "ZCODE_" packages apps scripts --include="*.ts" --include="*.mjs" | grep -vE "CUA|errors\.ts|error-code"
grep -rn "\.zcode" packages apps --include="*.ts" | grep -vE "CUA|computer-use|CDN"
grep -rn "zcode-" packages/ui/src packages/web/src | grep -v "mikiko-"
```

---

## 7. 新功能设计：Sub2API 账号体系（D8）

> 依据：对 `/Users/fatballfish/Documents/Projects/GoProjects/Personal/sub2api` 的源码调研（Gin + Ent + PostgreSQL；三套凭证体系：面板 JWT / 管理 JWT / 网关 `sk-` Key；**它不是 OAuth2 发卡方**，而是 OAuth 消费方，登录后签发自有 JWT+refresh token）。端点详情见调研结论，本节只落集成设计。

### 7.1 定位与总体形态

- Mikiko 的**主账号/主供应商体系**：内置 Mikiko 官方 Sub2API 站点（地址待定，占位常量），同时允许用户添加任意第三方 Sub2API 站点。
- 一个「站点 = 一个账号身份 + 一组密钥池」。站点配置持久化在 personal provider 配置层，凭据（access/refresh token）走 `credentialService` 加密存储（按站点隔离 key）。

### 7.2 登录与会话（M1）

- **主路径：邮箱密码 + 2FA**：`POST /api/v1/auth/login`（`requires_2fa` 时续 `POST /api/v1/auth/login/2fa`）→ `{access_token(JWT,24h), refresh_token(30d,轮转)}`。
- 刷新：401 且 reason=`TOKEN_EXPIRED` 时 `POST /api/v1/auth/refresh` 静默续期（**轮转型**，旧 refresh 立即作废）；失败引导重登。
- **注意坑**：sub2api JWT 绑定签发时 IP+UA 指纹，网络切换可能 401 → 客户端固定 UA（Mikiko UA，与 §4.4 新套一致）+ 处理重登提示。
- OAuth（GitHub/Google/LinuxDo/微信/钉钉/OIDC）作为增强：读 `GET /api/v1/settings/public` 探测启用项 → 打开 `GET /api/v1/auth/oauth/{provider}/start` 的 `authorize_url`（内嵌 webview），监听前端回调页 `/auth/oauth/callback` 的 `#access_token=...` fragment；新用户补注册走 `pending/exchange → create-account/bind-login` 链路。验证码（Turnstile）开启时降级为「到站点 Web 控制台完成」。
- UI：设置 → 账号与站点（新增区块）：站点列表（添加/编辑/删除/设为默认）、登录态展示、退出登录。

### 7.3 密钥管理与分组换绑（M2）

| 功能            | 端点                                           | 说明                                                                                                     |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 密钥列表        | `GET /api/v1/keys?page_size=100`               | 响应含 key 明文与状态（active/inactive/expired/quota_exhausted）、额度（quota/quota_used）、限流窗口用量 |
| 可绑分组        | `GET /api/v1/groups/available`                 | 分组决定 platform（openai/anthropic/...）与计费倍率                                                      |
| 换绑分组        | `PUT /api/v1/keys/:id {group_id}`              | 服务端校验绑定权限，失败回 4xx 展示原因                                                                  |
| 停用/启用       | `PUT /api/v1/keys/:id {status}`                |                                                                                                          |
| 创建/删除       | `POST /api/v1/keys`、`DELETE /api/v1/keys/:id` | 创建必填 name，可选 group_id                                                                             |
| 单 Key 明文补取 | `POST /api/v1/keys/:id/reveal`                 | 列表已含明文，兜底用                                                                                     |

UI：设置 → Sub2API 密钥管理页（列表卡片：名称、状态徽标、分组、额度进度条、限流窗口用量；操作：换绑分组、启停、删除、创建）。

### 7.4 余额 / 订阅 / 用量查询（M3，轮询制，无推送通道）

| 数据                          | 端点                                                                                                  | 频率建议                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| 账户余额+钱包                 | `GET /api/v1/console/bootstrap`（wallet.available_balance）                                           | 30–60s                           |
| 订阅额度                      | `GET /api/v1/subscriptions/summary`（daily/weekly/monthly used/limit）                                | 打开页面时                       |
| 用量统计                      | `GET /api/v1/usage/dashboard/stats` + `snapshot-v2`（trend/models/groups）                            | 打开页面时（heavy 60RPM 桶注意） |
| **当前选中 Key 的细粒度状态** | `GET /v1/usage`（**用该 Key 自查**：quota remaining、rate_limits 5h/1d/7d、today usage、model_stats） | 会话窗口角标，60s；不占面板配额  |

### 7.5 密钥切换 → 会话即时换模型路由（M4，核心体验）

1. 用户在密钥管理页（或会话窗口快捷切换器）选中某 Key → 写入「当前站点 + 当前 Key」选择态（personal 配置层，广播 `onDidChange`）。
2. 立即用新 Key 调 `GET /v1/models`（Bearer sk-xxx）刷新**该 Key 分组可用模型列表**（这是模型清单的权威来源；分组 model_allowlist 决定范围）。
3. Provider 注册表动态投影出一个 `sub2api` 供应商（`openai-chat-completions` 协议、`baseUrl={site}/v1`、apiKey=选中 Key、模型清单=第 2 步结果），模型选择器即时更新；当前模型若不在新清单中，回退到清单首个并提示。
4. **进行中会话**：下一个模型请求即用新凭据（沿用 `accountProviderRequestAuthService` 的凭据缓存失效模式——切换时使缓存失效，无需断开会话）；流式中途的当前请求不打断，完成后生效。
5. 出网走 §4.4 的 Mikiko UA 头。

### 7.6 验收要点

- [ ] 添加第三方站点 → 密码/2FA 登录成功，token 加密落盘，刷新与 401 重试正确（含轮转）
- [ ] 密钥列表/创建/停用/删除/换绑分组全通，失败原因可见
- [ ] 余额/订阅/用量面板数据正确，轮询不超限
- [ ] 切换 Key 后：模型列表刷新、选择器联动、进行中会话下一请求用新 Key（抓包验证 Authorization 变化）
- [ ] 断网/换网络后的会话绑定 401 有友好引导
- [ ] `pnpm typecheck` / `pnpm lint` / `architecture:check` 通过

### 7.7 落点与工作量估算

| 层       | 改动点                                                                                                   | 估算                   |
| -------- | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| shared   | Sub2API 类型与 zod schema（站点、密钥、分组、用量）、`sub2api` provider family 定义、Mikiko UA 头        | 3–4 人日               |
| services | `sub2apiClientService`（登录/刷新/密钥/分组/用量 API 封装）+ 凭据存储 + provider 动态投影 + Key 切换广播 | 1–1.5 人周             |
| ui       | 站点管理、密钥管理页、用量面板、会话内 Key 切换器、模型选择联动（i18n 双语）                             | 1.5–2 人周             |
| 联调回归 | 与真实 sub2api 实例（可参考 sub2api 仓库内 `mikiko-pool/` 的多站点设计）                                 | 3–4 人日               |
| **合计** |                                                                                                          | **约 4–6 人周（MVP）** |

---

## 8. 验收 Checklist（品牌更名部分）

- [ ] 桌面 App：Dock/DMG/About/托盘/窗口标题显示 Mikiko；与官方 ZCode 并存互不干扰（appId/数据目录/userData 全隔离）
- [ ] 欢迎页/引导页/更新弹窗/错误提示无 ZCode 字样（zh + en）；首启即全新状态（无任何旧数据残留读取）
- [ ] 主题切换正常（mikiko-\*）
- [ ] Web：title/favicon/分享落地页为 Mikiko；分享「继续使用」走 `mikiko://`
- [ ] TUI：产品名、`--help`、启动文案为 Mikiko；CLI 可执行名 `mikiko`
- [ ] `MIKIKO_*` env 全链路生效；`~/.mikiko` 数据根生效；`ZCODE_CUA_*` 保留原值
- [ ] RPC 双读窗口生效（新旧 server 混连可用）
- [ ] Z.ai/BigModel OAuth（zcode:// 回调）仍可用（三方供应商路径）
- [ ] 出网头双套：z.ai/bigmodel 供应商发 ZCode 头，其余发 Mikiko 头
- [ ] 远程工作区（SSH/WSL/Docker）部署与连接正常
- [ ] 安装器品牌正确；CUA 入口默认隐藏
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过
- [ ] S6 扫描残留为 0（或全部标记「有意保留」并登记 §5）

---

_附：[MIKIKO-BRAND-ASSETS.md](MIKIKO-BRAND-ASSETS.md) 品牌资产规格清单与兜底方案。本文档行号基于 main @ 872ad96；执行中发现清单外新标识，先补进本文档再改动。_
