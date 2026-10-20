# R6 基础设施独立复核

日期：2026-10-21。只读审查父协作者的 source，仅增补获准独占的 `scripts/test/isolated-test-runner.test.mjs`。未执行整套 CLI 或三次真实构建，未提交或修改正式 profile。

## 结论

当前复核范围没有未解决的 Critical / Important。审查中发现的 Windows shell 参数、取消回收和 ambient 数据路径三类 Important 已由父协作者修复；测试者没有修改其 source。Windows 原生执行仍是验证限制，不能把 macOS 结果当作 Windows 已通过。

## 已发现并关闭的问题

| 问题                                            | 证据与真实触发                                                                                                                                                                                             | 修复复核与验证                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows 正则参数进入 shell                      | 初版对非 node 命令使用 shell:true，空白引号 helper 对 `foo\|bar` 这种无空白过滤表达式原样输出；cmd 会把管道符解释为命令。此为静态证据，未在 macOS 冒充原生 cmd 复现。                                      | 最终 runner 全程 shell:false；node/vitest 用真实 Node/JS 入口，pnpm 有 npm_execpath 解析。使用真实小 Vitest 项目、带空格目录和 `foo\|bar` 参数验证恰好执行 2/3 合成用例。                                          |
| 取消后孙进程仍运行、子进程优雅返回 0 可误报成功 | 合成两层子进程先红：wrapper 已退出 143 且 HOME 已清理，孙进程仍存活。日志 `/tmp/mikiko-r6-isolated-runner-review.log`；失败夹具 PID 随后由测试自行回收。                                                   | 最终 POSIX 使用独立进程组并向组转发信号，close/finally 清残留；记录父取消信号，避免子进程返回 0 覆盖取消。SIGTERM 单命令/孙进程、SIGTERM/SIGINT 优雅返回 0 均通过。Windows 改为 taskkill /T /F，未做原生执行验证。 |
| HOME 隔离被 ambient 产品路径覆盖                | 初版保留 MIKIKO_HOME / MIKIKO_LOG_DIR。Telemetry bootstrap 优先读写 MIKIKO_HOME/v2 身份文件；Logger factory 优先使用传入 env 的 MIKIKO_LOG_DIR。合成父目录注入后，MIKIKO_HOME 隔离断言先红；未触真实目录。 | 最终删除这些 ambient 覆盖项及相关 legacy/desktop/mailbox 路径键，只改子进程 env 副本。exit 0/7 场景验证子字段已清除、父目录未写入、临时 HOME 已删除；直接 import 调用验证调用方 HOME/data env 不变。               |

## 暂存与构建入口

- 普通 pnpm、bootstrap-with-remote、Turbo 三条分支均在运行时构建校验后 `await stageDevAgentBundle()`；该唯一入口顺序执行 stageAgentBundle → stageOfficialPlugins → stageBundledSkillPack。
- 新导入的 `prepare-agent-node-bundle.mjs` 在 direct-entry guard 之前没有构建/暂存执行。作为 library 导入只提供常量和函数；`build-desktop-agent-cli.mjs` 本身仍是构建命令入口，未把它视作可无副作用导入的库。
- 暂存只读仓库参数目录，清理旧 target 后复制 `.mikiko-plugin` / legacy manifest、`.mcp.json`、dist、skills、agents、docs、scripts 等；发现新品牌 manifest 优先，过滤 node_modules/.venv/**pycache** 等缓存。必需 runtime 在 source 校验，必需 seed 在 destination 校验；缺失即失败，不借个人插件缓存补齐。
- `stageBundledSkillPack` 使用同一目标根并验证 dynamic-workflows 必需文件。
- 根 package 默认 Vitest/Node/affected/coverage 入口及 CLI workspace 的整体 test、CLI Node test 已接入隔离 runner；既有 Node 测试清单包括新增 runner 与资产暂存测试。只读审查未发现这次接入遗漏正式默认入口。
- 独立运行 `scripts/test/desktop-agent-plugin-assets.test.mjs`：**4/4 通过**，日志 `/tmp/mikiko-r6-plugin-staging-review.log`。这是暂存合同验证，不等于实际执行三条构建和每个 MCP runtime。

## MCP 身份目的地

已对照 `packages/shared/src/official-mcp-auth.ts` 新工厂，以及 `packages/services/src/node.ts`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` 两个生产装配点：

- Host 二次校验和 Agent HTTP 信任共用 CodingPlan account resolver。
- Agent stdio 的 targetOrigin 同样来自 account resolver，未再使用产品 origin。
- production 默认和自定义产品域均不能因此获得官方凭据授权；插件身份本身不授予 origin 信任。
- HTTP loopback 仍需显式配置；无关 HTTPS、远端 HTTP、含 userinfo 的 URL 不能冒充账号服务。

独立运行 `packages/shared/test/codingPlanMcpDestination.test.ts`：**4/4 通过**，日志 `/tmp/mikiko-r6-mcp-destination-review.log`。未执行真实账号请求、stdio 插件或完整 MCP 集成；非生产显式账号测试源继续按此前合同保留。

## Runner 验证与覆盖率

最终 **10/10 通过**：exit 0/7、缺参、spawn 失败、单命令取消、孙进程取消、两种取消信号下的优雅 0、直接 import 调用的父 env 不变、真实 Vitest 正则过滤。取消夹具只回收本次记录的 PID，使用条件等待验证退出；不枚举/终止用户进程。

最终真实 Node 覆盖率：**line 87.78% / branch 60.00% / functions 85.71%**。CLI catch 已执行；分母包含本平台未执行的 pnpm npm_execpath 与 Windows taskkill 路径，未为达到阈值模拟命中这些路径，也不宣称 95% 门禁通过。

日志 `/tmp/mikiko-r6-runner-final-coverage.log`；原始 V8 JSON `/tmp/mikiko-r6-runner-v8/`。额外先红证据 `/tmp/mikiko-r6-runner-path-overrides-red.log`。测试文件格式检查、Lint（0 错误/警告）和 diff 检查完成。

范围限制：macOS arm64 实跑；Windows taskkill/原生 pnpm 未实跑，故意脱离父进程组的子进程及拒绝终止的进程未验证；未做实际完整包构建或生产资产发布。本报告只关闭已审查且有对应证据的问题。
