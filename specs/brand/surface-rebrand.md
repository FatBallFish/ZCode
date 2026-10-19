# 进程名 / 环境变量 / 落盘文件名品牌化（2026-10-15 四面审计）

四类「对外可见 zcode 残留」的收敛记录，按 `MIKIKO-REBRAND-PLAN.md` 的分组决策执行。
原则：自实现产品面全改；官方协议、已部署远端兼容、E2E/构建 harness 不动。

## 1. 进程名（ps/活动监视器可见）

- 统一前缀 `zcode-` → `mikiko-`：`packages/shared/src/process-names.ts`
  `ZCODE_PROCESS_PREFIX = "mikiko"`（常量名保持代码符号不变）。host
  （mikiko-host-local-N）、renderer（mikiko-renderer-*）、agent、utility 全部经
  formatZCode*ProcessName 自动跟随。
- CLI 进程标题：`apps/zcode-cli/packages/cli/src/process-name.ts`
  `CLI_PROCESS_NAME = "mikiko-cli"`；`CLI_COMMAND_NAME = "zcode"` 属安装产物命名
  空间（plan §3.3 / D8），暂不改。
- 补漏（2026-10-15 审计后复查）：node-repl MCP 进程标题不经 process-names.ts
  统一前缀，首查遗漏（同文件只改到 PLUGIN_ROOT 环境变量）。
  `apps/zcode-cli/packages/node-repl-host/src/server.ts`
  `NODE_REPL_MCP_PROCESS_TITLE = "mikiko-node-repl-mcp"`；同文件 worker 消息
  判别器 `WORKER_KIND` → `mikiko-node-repl-call`（server 以
  `new Worker(import.meta.url)` 自 fork 同一产物，两端同构建，无跨版本兼容）；
  desktop E2E 进程树断言常量同步。
- 前缀匹配方同步：`desktopStabilityTelemetry.ts` 角色映射同时认 `mikiko-host/agent`
  与旧 `zcode-host/agent`（同版本混跑窗口期）；`desktopCommandHandlers.ts`
  endpoint-submit title 握手串 `zcode-endpoint-submit:` → `mikiko-endpoint-submit:`
  （注入脚本与读取端原子改）；agent lifecycle 日志标记
  `[mikiko-agent-lifecycle-reported]`（常量值改，解析端引用常量）。

## 2. 环境变量（运行时产品面，~80 个）

`ZCODE_` → `MIKIKO_`：plan §3.1 组 A（路径）/B（端点）/C（进程间）+ CLI 用户可
export 项（STORAGE_DIR/HOME/BETA/GIT/RG/UGREP/BFS_BINARY/PLUGIN_ROOT/LOG_* 等）
+ 调试开关（DEBUG/ARMS_RUM_ENDPOINT/TELEMETRY_REPORT_ENDPOINT/LOCAL_TTFT 等）
+ `GLM_BINARY_PATH` → `MIKIKO_AGENT_BINARY_PATH` + Vite 注入 `VITE_ZCODE_*` →
`VITE_MIKIKO_*`。写读两端同仓库原子替换，无旧名回退（plan D1 全新品牌语义）。

补改（2026-10-19）：`ZCODE_ENABLE_MAC_SIGN` → `MIKIKO_ENABLE_MAC_SIGN`——Mac
出包签名总开关，`bundle.mjs` 与 `electron-builder.config.js` 两处判定口径原子改。

补改（2026-10-19 第二轮）：**构建 harness 组整体 `ZCODE_` → `MIKIKO_`**（约 50 个）：
`ZCODE_ENV`（仅变量名字符串；TS 常量 `ZCODE_ENV` 与编译期 define `__ZCODE_ENV__`
按 §5 代码符号口径保留）、注：`ZCODE_COMMIT` 的 TS 常量名因批量词边界替换无法
与变量名字符串区分，已随值一并改为 `MIKIKO_COMMIT`（version.ts 及全部引用，
typecheck/单测全量通过；`ZCODE_ENV`/`ZCODE_VERSION` 等其余常量名保持不变）、`TARGET_OS/TARGET_ARCH/COMMIT/SKIP_*(REMOTE_ASSETS/
PREPARE/BUILD)/CSC_PATH/ENABLE_WINDOWS_SIGN/ENABLE_WINDOWS_BROWSER_IMPORT/
DESKTOP_DIST_DIR/ELECTRON_RUNTIME_MIRROR/DESKTOP_AGENT_(BUILD_MODE|BYTECODE)/
PREVIEW_IDENTITY/INSTALLER_NSH/UNINSTALLER_LOG_PATH/SHORTCUT_PATH/BUILD_PATH/
MACOS_RELEASE_APP_PATH/APP_EXECUTABLE_NAME`（doctor）、`NATIVE_SEARCH_DEPS_ROOT/
NATIVE_SEARCH_ALLOW_PUBLISH/NODE_DIST_MIRROR/(UGREP|VIIZ|BZIP2|ZSTD|ZLIB|PCRE2|
BROTLI)_SOURCE_DIR/UGREP_OUTPUT_DIR/REFLEX_SOURCES`（CMake 对）、`CI_TMPDIR`、
`AUTO_UPDATE(_DEV|_DEV_VERSION)`、`PACKAGED_AGENT_OTEL_(ENDPOINT|HEADERS|
SERVICE_NAME)`、`BOOTSTRAP_WITH_REMOTE`、`DIST_(BASE_URL|HOME|BIN_DIR)`、
`DEPS_BASE_URL`。同步面：desktop/CLI 构建脚本、
electron-builder 配置、vite/tsup/turbo/wdio 配置、根 `.env*` 模板、`.vscode`、
GitHub Actions（release-desktop.yml）、docs/specs 活文档与 NSIS/CMake 定义。

第二轮同时修复首轮审计漏网（读写两端原子改）：
- `ZCODE_PRODUCTION_BASE_URL`/`ZCODE_TEST_BASE_URL` → `MIKIKO_*`（DRE scoped
  读取、vite、E2E passthrough、`.env.development/.env.production` 模板）；
- `.env.example` 7 个端点模板键（BASE_URL/CDN/SHARE/REMOTE_ASSET_CDN/
  BUILTIN_PROVIDER_CONFIG_FILE/DEPS_BASE_URL/DIST_BASE_URL）改 `MIKIKO_*`
  （源码读取端首轮已改，模板漏改会静默失效）；
- `.vscode/start-electron.mjs` `ZCODE_DEBUG` → `MIKIKO_DEBUG`（运行时读
  `MIKIKO_DEBUG`，旧名已致 host 调试端口失效）；
- `ZCODE_BIGMODEL_USAGE_(API_KEY|QUOTA_URL)` → `MIKIKO_*`（`BIGMODEL_*` 原名保留）；
- 产品代码读取的 dev 开关补改：`ZCODE_WINDOWS_APP_INSTALL_DIR`（DRE 注入 ↔
  services paths 读取对）、`ZCODE_REMOTE_DEV_AGENT_BUNDLE`（远端 dev 部署）、
  `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`、`ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA`；
- docs/specs 过期引用同步：`ZCODE_UPDATE_FEED_URL` → `MIKIKO_UPDATE_FEED_URL`、
  `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`/`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`
  → `MIKIKO_*`（源码读取端均已用新名；`VITE_ZCODE_E2E_STORE_BRIDGE` 属 E2E 族保留）。

**远端兼容（D6 双读先例）**：`ZCODE_ENV` 与 `ZCODE_(PRODUCTION|TEST)_BASE_URL`
属于 client ↔ 已部署远端 server 的转发契约（`connect.ts` `REMOTE_RUNTIME_ENV_KEYS`）。
新 client **双转发**新旧两组键名，`zcodeEndpoint` 环境解析
**优先 `MIKIKO_ENV`、兜底 `ZCODE_ENV`**；远端整体换代后删除旧键与兜底。

**保留不改**（明确清单）：
- `ZCODE_CUA_*` 全部（plan D7：官方 Helper 签名互验）；
- `ZAI_*`、`BIGMODEL_*`、`OPENAI_*` 等第三方官方配置；
- `ZCODE_E2E_*`（~60 个，含 `VITE_ZCODE_E2E_STORE_BRIDGE`）与纯测试/开发夹具
  （smoke、offpeak-mock、pre-push 等）——CI/dev 测试矩阵，暂不在改名范围；
- 运行时调参/灰度旋钮（`ZCODE_MODEL_RETRY_*`、`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE*`
  等）——产品内部调参面，后续单独评估；
- `ZCODE_SERVER_*`（client↔已部署远端 server 的启动命令/凭据管道，改名会切断存量
  远端实例，与 zcode-server.cjs 产物名一起待远端整体换代时原子处理）；D6 双读窗口
  内 `ZCODE_ENV`/`ZCODE_(PRODUCTION|TEST)_BASE_URL` 旧键随窗口删除；
- GLM/ZCode 旧 CLI 用户环境兼容读取（`ZCODE_API_KEY`/`ZCODE_MODEL`/`ZCODE_PROVIDER`
  /`ZCODE_SESSION_DB` 等既有用户 shell/配置存量）；
- TS 常量标识符（含 `ZCODE_ENV` 常量名、`*_ENV_KEY` 常量名）、编译期 define
  `__ZCODE_*__`、window 全局 `__ZCODE_*__` 与 `ZCODE_*` error-code 常量值（plan §5）。

## 3. 落盘文件/目录名

| 项 | 改动 |
| --- | --- |
| `~/.zcode/cli`（GLM provider 配置根） | `nativeConfigDir` → `.mikiko/cli`，与主进程 `node.ts` 既有读取统一（此前 Host 落旧目录、主进程读新目录的分裂修复）；`getProviderWorkspaceConfigDir` 内一次性迁移 `config.json`（含 provider 凭据，缺失才复制，幂等静默） |
| `~/.zcode/v2/telemetry-state.json` 读取 | `provider-endpoint-routing-source-headers.ts` 改读 `.mikiko/v2`（写入端早已写新路径的读写失配修复） |
| workspace 插件配置识别 | `plugins.ts isWorkspacePluginConfigPath` 只认 `.zcode/config.json` 而实际写 `.mikiko/config.json` 的漏认修复（统一认 `.mikiko`） |
| agent 工具提示词路径 | `.zcode/agents/*.md` → `.mikiko/agents/*.md`（真实目录） |
| 日志导出 zip | `zcode-diagnostic-logs.zip` → `mikiko-diagnostic-logs.zip` |
| CLI jsonl 日志 | `~/.mikiko/cli/log/zcode-*.jsonl` → `mikiko-*.jsonl` |
| tmp 目录 | `zcode-plugin-*` → `mikiko-plugin-*` |
| userData 遥测 | `zcode-data-size-telemetry.json` → `mikiko-…`（可重建，无兼容） |
| 种子/缓存标记 | `.zcode-plugin-seed.json`→`.mikiko-plugin-seed.json`、`.zcode-bundled-skills-seed.json`→`.mikiko-…`、`.zcode-plugin-sync.json`→`.mikiko-…`（同步包内，读旧名双兼容）、`.zcode-runtime-tool.json`→`.mikiko-…`（读旧名兼容）、`zcode-builtin-refresh.json`→`mikiko-…`——凡 gate 幂等解压/种子的均带旧名读取，避免升级后重复种子覆盖用户改动 |
| dev staging | `.zcode-runtime/desktop-dev` → `.mikiko-runtime/desktop-dev`（仅 dev 脚本，零用户影响） |

**保留不改**：`~/.zcode/computer-use`（D7）；`~/.zcode/server`、launchd
`com.zhipu.zcode.server`、命名管道 `\\.\pipe\zcode-server-*`、产物名 `zcode.cjs/
zcode-server.cjs`（已部署远端与 CDN 兼容，D8）；`zcode.json` workspace 旧配置只读
发现；`~/.zcode/v2`、`~/.zcode/cli` 旧目录不迁移其余内容（读侧已全部指向 .mikiko，
旧目录成死数据，可手动清理）。

## 4. 内置提示词/用户文案

见 `agent-prompt-naming.md` 既有口径，本轮补漏：`/init` 内置命令提示词
（builtin-prompt-command.ts）、lark 会话引用 system-reminder、node-repl Browser
错误、各内置插件 SKILL.md 品牌句（`window.zcode` API 名保留；技能内 CLI 命令
`zcode xxx` 保留）、i18n value（key 名不改）、force-update/权限面板/浏览器面板/
官方插件市场描述/web 分享落地页等。`${ZCODE_SKILL_DIR}` → `${MIKIKO_SKILL_DIR}`
（技能运行时注入方已同步改名）。

## 验收

1. `ps` 中进程名为 mikiko-host-*/mikiko-cli/mikiko-renderer-*，无 zcode- 前缀进程。
2. 新会话 spawn 的子进程 env 注入 `MIKIKO_*`；shell 导出 `MIKIKO_STORAGE_DIR/
   MIKIKO_HOME/MIKIKO_UPDATE_FEED_URL` 等生效，`ZCODE_*` 同名变量不再被读取。
3. 升级后首个会话仍持有既有 provider 账号（`~/.zcode/cli/config.json` 已迁移）。
4. 官方能力回归不受影响：智谱 OAuth 深链、BIGMODEL/ZAI 端点、CUA Helper
   （ZCODE_CUA_*）、远端 server 连接（ZCODE_SERVER_*）行为不变。
