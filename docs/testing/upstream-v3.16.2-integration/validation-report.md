# v3.16.2 合入验证记录

执行时间：2026-10-20 至 2026-10-21。实现及功能测试已收口；采用保留双亲的合并提交集成本地 custom_main，实际来源和回滚点如下。

## 来源与回滚

- 原分支提交：`4a971eaac771363da0aa8fe69571ca4d9b1463eb`，回滚标签 `custom-main-pre-v3.16.2-20261020`。
- 上游固定为 `075fde8429f15bc5baa018f4605ea776770dbf8d`（v3.16.2），本地 main 已更新。
- 原本地与远端 custom 先合并为 `af8285c212846ffe47ebdf5a7ba90b4d1dbe3c7b`；采用 merge，不重写历史、不 squash。3.16.1 检查点 `25c136ac`，最终 3.16.2 在隔离分支收口。
- 应用保持二开发行版本线 `1.1.3`，上游来源独立记录；本次未推送、部署或发布。

## 用户决定落实

| 要求                     | 实现与证据                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手机保持自建             | 当前 RemoteControlDialog → remoteControl/service → relay-server 票据/RPC 链保留，不装配 Relay V2 及其官方账号门禁。当前 relay-server 真实 WS/票据/RPC Node E2E、Electron 自建入口通过；旧 HMAC 只作遗留 transport 回归 |
| 云服务自建、官方账号例外 | 产品配置/反馈/分享/更新/插件/Source Server 使用自建端点；生产自定义产品域也不能改变官方账号来源。OAuth、套餐预览/领取、MCP 套餐额度走专用账号 resolver；边界 6 套 264 项通过                                           |
| 新产品标识 Mikiko        | 新 env、路径、manifest、分发文件、Server CLI、cron/voice 标题、TUI 字标、Android 可见名统一 Mikiko；实际 Electron 指标、TUI 渲染和 APK label 验证                                                                      |
| 保留二开与历史行为       | 工作树真实 cwd/身份及根项目聚合、置顶、分屏/DnD、独立窗口共享 Host、语音/统计、ChatGPT/Sub2API、皮肤/桌宠/CDP/打开方式保留，能力移植至上游新 owner；根仓/Node/真实 Electron 分层验证                                   |

协议判别器、内部包 scope、持久 ID、官方账号 wire 字段、旧数据只读兼容和第三方签名身份按合同保留，不机械替换。分类见 [品牌与端点核对](./brand-and-endpoint-review.md)；功能移动与取舍见 [功能台账](./upstream-disposition.md)。

## 当前验证结果

| 检查                         | 实际结果                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 根仓 typecheck               | 最终产品 TS 冻结后完整命令 exit 0                                                                                                                                              |
| CLI typecheck / lint         | 根 workspace Turbo 入口类型检查 32/32 任务成功；CLI lint 0 错误、73 警告，9 项固定原样上游行数诊断按既有策略接纳                                                               |
| 根仓 lint                    | 0 错误、175 警告，不把告警称为零诊断                                                                                                                                           |
| architecture --changed       | 0 违规、0 baseline；历史豁免绑定固定 blob，未刷新违规 baseline                                                                                                                 |
| 全仓 fmt:check               | 初检 exit 1：2111 个差异；其中 1955 与上游 blob 一致、147 与二开输入一致；本次适配的 9 文件已规范并定向格式检查通过，保留 2102 个来源原文差异                                  |
| 架构治理自测 / SQLite schema | 36 项 / 8 项通过，app/CLI 两份 schema 基线兼容                                                                                                                                 |
| 根仓 Vitest 全量             | 当前 2103 个规格逐文件对账无遗漏，最终 20210 项通过、9 项按原条件跳过、0 失败                                                                                                  |
| 根仓 Node 全量               | 338 项通过，0 失败、0 跳过                                                                                                                                                     |
| CLI 完整默认链               | 最终默认命令 exit 0：42/42 任务成功：24 个 build 缓存、18 个 test 全部 fresh；含 wrapper 共 12964 项通过、40 项跳过、0 失败，24m4s；原 5s 时限未改，详见 cli-test-summary.json |
| Desktop + CLI bundle         | 最终冻结运行时代码完整 fresh build 通过                                                                                                                                        |
| 原生 Electron                | INT-E2E-01/02/03 全部使用最终产物通过，无条件空跑替代关键断言                                                                                                                  |
| 真实浏览器 UI                | Composer 桌面/手机明暗 4 项、SidePane 插件桌面/手机/恢复/并行安装 16 项通过                                                                                                    |
| Android                      | 私有 JDK21/SDK36.1，assembleDebug + compileDebugAndroidTestKotlin 通过，47 tasks；APK label Mikiko。无设备，instrumentation 未运行                                             |
| 自建分发/恢复                | Source publisher/default/recovery/旧 feed 的真实 loopback 子进程 4 文件 16 项通过；Server CLI 37 文件 241 项通过；未生产上传                                                   |
| 第三方声明                   | 当前实装图 1226 个精确包版本声明已生成；rrweb2.0 补固定发布提交许可原文；图读取串行资源回归 5 项通过，未放宽原有资料限制                                                       |
| 独立高风险评审               | 2 个 Important 已修复并复核关闭，评审范围无未解决 Critical/Important                                                                                                           |

根仓使用 fork 分片和串行 IO 项目。失败修复后整文件重跑，取最后结果；将当前 `vitest list --json --filesOnly` 与全部结果逐文件比较，确认新增用例未造成分片遗漏。按最终文件去重，不累加重复回归。机器摘要及全部跳过项见 [root-test-summary.json](./root-test-summary.json)。Windows 两份原生安装 smoke 文件按原平台条件跳过。最终仅格式规范的 4 个触及 Vitest 文件另行整文件 24 项回归通过（`/tmp/mikiko-format-regressions.json`）；更新服务的 Node 文件另有 10 项通过，不重复计入全量数量。

## 真实 Electron 证据

| 场景                              | 非 UI 断言                                                                                     | 最终 run ID                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| INT-E2E-01 工作树/独立窗          | detached worktree、root HEAD 不变、资产拷贝、SQLite cwd、根项目归属、子窗开关前后同一 Host PID | desktop-e2e-20261020160055908-p91101-8f78a70c1ac4f202 |
| INT-E2E-02 Composer/统计/语音拒绝 | loopback wire 模型一致且主请求一次、1 turn/1 step、未发送草稿保留                              | desktop-e2e-20261020160055908-p91101-8f78a70c1ac4f202 |
| INT-E2E-03 皮肤/远控入口          | theme.json、刷新 localStorage、disabled config、0 provider 请求、实际 mikiko-cron-scheduler    | desktop-e2e-20261020154250848-p44240-56bd4f4842d4e53c |

JSON/PNG/网络/运行日志保留在本次工作树 `/Users/fatballfish/.codex/worktrees/integrate-upstream-v3-16-2/ZCode/packages/desktop/.e2e-artifacts/`。详见 [Desktop/Web 验证](./desktop-web-validation.md)。候选保持 pending，不冒充人工 review、正式 CI 或 Docker admission。

## 失败与修复记录

首次全仓出现线程内存错误和旧品牌/协议断言，不计为通过；随后以 fork、受限并发及串行 IO 收集完整结果。两个全量 pnpm 图即使独占也会短暂耗尽文件表，已改串行读取并用真实子进程回归，不提高系统限制。

真实修复包括 Host provider 配置根错位、旧远端附件重传与清理边界、CLI Mikiko env 被忽略、官方账号与产品域混用、Memory 品牌替换减少敏感目录保护、附加 subagent 与 bundled workflow 路径遗漏、SEA 插件版本表不一致、生产态远端开发脚本旧 env/缓存、E2E run/flag/cache 合同错位。均记录根因和先失败后通过证据，不靠删功能或延长产品超时通过。

## 验证边界与发布准备

- 测试仅使用隔离 HOME、临时数据库、Git 仓库与 loopback fixture，未在个人正式 profile 或生产数据库验收。
- 未执行生产官方账号登录/领取、Mikiko ID 设备认领、手机真机 P2P、实际录音识别、Windows/Linux 原生窗口/安装及签名公证。协议/模拟测试不能替代这些环境。
- Source Server 自建发布链和 HTTP 回读已验证，生产归档/目录仍需正式发行。Office 自建字体对象未预置（只读探测 404），无官方 CDN 运行时回退，发布前须准备资源。
- 代码回滚锚点已建立；未来 profile 升级的数据恢复按迁移备份合同处理，本轮未迁移正式数据。

[file-review.tsv](./file-review.tsv) 记录 Git blob 来源，不等于逐行人工审阅。[独立评审](./independent-review.md) 记录审查边界及问题闭环；本报告只声明实际执行和可复核范围。

最终通过的两个 run 目录已逐文件 SHA-256 校验后复制回主工作区，长期证据位置：`/Users/fatballfish/Documents/Projects/ClientProjects/ZCode/packages/desktop/.e2e-artifacts/upstream-v3.16.2-integration/`。原测试 cwd 继续保留在 JSON/日志中作为执行上下文。

CLI 类型检查使用根工具入口 `mise exec -- pnpm exec turbo run typecheck --cwd apps/zcode-cli --concurrency=1`；嵌套 workspace 直接运行原 typecheck 脚本时无法解析外层 Turbo，最终验证执行同一任务图，不跳过包。

第三方声明在最终包清单冻结后重新生成：1226 个精确包版本、12 份复制组件、18 份原生归档；`readVerifiedNotices` 新鲜度校验通过。根仓与 CLI 的最终静态检查日志及测试原始 JSON 将与 Electron 证据共同归档到上述主工作区的 `verification/` 子目录。

## 主工作区最终收口

合并提交为 `220e237424d9e5926494dda8f49abb3a5d0b7248`，双亲及上游、远端custom、回滚锚点祖先关系已验证；主工作区 `custom_main` 已通过 ff-only 接入。锁文件安装退出0，未更改发行版本1.1.3。

隔离分支无远端追踪时，手工默认门禁的测试选择器尝试不存在的origin/staging而退出2；使用工具已有的显式固定上游基线后通过。该门禁按既有规则在选中整个套件时跳过UT，不能把门禁退出0当作全量UT通过；全量与新增文件实际执行结果按机器摘要对账。

主分支以真实origin/custom_main比较，曾暴露11个Source Server适配文件未受管。现补齐6个真实模块的owner、requires、公有入口与五件套，未新增运行时状态owner；原来3个连接/档案/迁移大文件仅按精确路径保留行数及原lint注释，理由记录220e2374固定blob，不刷新违规baseline，也不豁免依赖或cycle规则。主工作区默认架构检查现0违规、0baseline。

传输适配器的原反向类型引用迁入独立types.ts，原类型导出兼容；两个实现文件前后生成JavaScript有效token及hash完全相同（`mikiko-source-boundaries-js-equivalence.json`）。运行时错误类、工厂、探测命令与取消逻辑均保留，原生Electron的运行语义未改变。

新增6个合同文件25项测试，并联合原传输37项重新执行，共7文件62项通过。最终清单从原2097增加至2103文件，旧文件无移除；机器摘要跨两个checkout按仓库相对路径匹配，无遗漏或重复计数。新增Host fixture最初遗漏严格schema必填lifecycleState，已补合法active值并加入schema断言，最终根仓typecheck通过。
