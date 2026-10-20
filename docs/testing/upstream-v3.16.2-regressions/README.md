# Mikiko v3.16.2 合入回归修复验收

日期：2026-10-21。修复基线为 `custom_main` 的 `3358e20a`；未推送远端。需求与所有者/事件顺序见 `specs/integration/upstream-v3.16.2-regressions.md`。

## 修复范围

| 问题             | 根因及处理                                                                                                                                   | 验收边界                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1 项目清单消失  | 源码允许首次项目迁移缺少旧设置快照仍记账为空；真实空种子与历史清单符合此缺陷，具体写者未确认。现统一注入内部只读迁移端口，阻止继续擦除旧清单 | 不改已发布迁移/checksum；同 profile 权威备份恢复，保留空项目与所有任务事实                                    |
| R2 辅助功能/录屏 | 当前 producer 是明确占位包；官方完整 producer 不在公开源码/包中，安装的官方 Helper 有启动器与签名身份约束，不能直接作为 Mikiko Helper        | 明确显示此构建不提供能力，不再误报启动中；真实 Helper 权限能力未恢复                                          |
| R3 官方账号      | 账号域隔离后来源头漏传，balance 返回参数错误；套餐配置还指向未部署的自建代理                                                                 | 官方账号限定路径补既有来源头，账号配置回独立官方 resolver；产品更新等继续自建                                 |
| R4 重复导航      | DesktopTopOverlay 中同组按钮渲染两次                                                                                                         | 删除重复组，保留单一可交互入口                                                                                |
| R5 手机白屏      | RPC 已连通，但禁止打开工作区的 Root 缺少 initialWorkspace；可选桌面账号代理还被误判为存在                                                    | 附着原 Host 的本地 active 投影，省略不存在的可选能力；只发布自建 Pages，不装配 Relay V2                       |
| R6 MCP           | 缓存带旧测试入口/flags；Dev 未暂存插件资产，品牌 manifest 暂存规则不完整                                                                     | 每个运行实例绑定当前入口；Dev/打包复用同一资产暂存；第三方与用户配置不改                                      |
| R6 图片搜索      | 原自建接口无后端、返回 404                                                                                                                   | 按用户新授权用官方 CodingPlan MCP，整条连接逐请求要求有效智谱登录；保留独立 custom 后端端口，不能继承官方凭据 |
| R7 语音模型菜单  | 未传会话菜单使用的 composerOptions，落到旧模式                                                                                               | 复用同一菜单及单一 voiceCleanupSelection 写入，保留思考档规则                                                 |
| R8 独立会话插件  | 独立窗口缺 PluginUiWorkspaceProvider 和市场动作                                                                                              | 复用本窗口 useAppPanels，保留 window-scoped Host                                                              |

## 正式数据恢复

先关闭 Dev 写者并在一致性副本验证，再经 `scripts/recover-project-seed.mts` dry-run/apply。脚本要求源/设置/全库逻辑指纹一致、组织表为空、任务无既有归属；先备份，事务内重新校验，发现触发器修改任务其他字段也回滚。

正式结果：**21 个项目、21 个 roots、42 个任务归属恢复、4 个空项目保留**。恢复执行时总计 104 条任务，其余 62 条保持未归属。独立对照正式恢复前备份确认：任务除 project_id 外逐列不变、其他表完全不变、设置字节不变。早先副本有 93 条任务；新增 11 条空任务保留，未据此推断项目或删除数据，具体历史写者未确认。

权威来源是同一 Mikiko profile 的历史清单，没有导入其他旧品牌 profile。原始来源、任务、路径、数据库与可回滚备份只存私有恢复目录，不提交仓库。恢复前备份及独立复核另保存一份权限 0700 的持久副本，避免临时目录清理后丢失。

## 已执行验证

| 层级                        | 真实结果                                                                  | 证据                                               |
| --------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| 父任务装配后回归            | 9 个目标文件 122/122 通过                                                 | `/tmp/mikiko-regression-parent-tests.json`         |
| 最新 MCP 与账号门禁回归     | 4 文件 58/58 通过，真实 stdio 和合成身份 HTTP loopback                    | `/tmp/mikiko-regression-parent-mcp-tests.json`     |
| 测试隔离/插件资产 Node 回归 | 14/14 通过                                                                | `/tmp/mikiko-regression-parent-node-tests.log`     |
| CLI Node 全套               | 520/520 通过；个人缓存前后指纹不变                                        | `/tmp/mikiko-isolated-cli-node-full.log`           |
| R1 定向回归                 | 97/97 通过，含首次迁移、损坏设置、重复启动、恢复指纹/触发器回滚           | `/tmp/mikiko-project-repair-targeted.json`         |
| 官方账号完整定向链          | 285/285；真实只读 balance 200，未重置/领取/调用模型                       | `accounts-and-mobile/`                             |
| 手机                        | 7/7；生产页 393×852 真实 Chromium + RPC/P2P，无未处理页面异常             | `accounts-and-mobile/`                             |
| UI R4/R7/R8                 | 定向 11 + Node 5；真实浏览器 6 场景                                       | `../ui-regressions-2026-10-21-478.md`              |
| Helper 可用性               | 定向 35；真实浏览器 4 场景；官方实现与签名限制核查                        | `../computer-use-build-availability-2026-10-21.md` |
| 独立基础设施复核            | 取消孙进程、Windows shell 解释、ambient 路径覆盖三类问题已修复            | `../r6-infrastructure-independent-review.md`       |
| 最新 CLI 构建               | 普通 pnpm 构建、Office runtime、品牌 manifest、内置技能和插件资产暂存成功 | `/tmp/mikiko-regression-cli-build.log`             |

覆盖率均取真实 V8 输出：R1 恢复文件语句 99.03%/分支 90.24%；手机 bootstrap 四项 100%；MCP 两文件行 93.38%/分支 79.22%；隔离 runner 行 87.78%/分支 60%；账号两文件行 69.5%；UI 页面整文件行 67.08%；Helper UI 范围行 48.8%，Main resolver 行 100%。这些大型文件的定向回归不覆盖无关存量分支，**不宣称全仓或统一 95% 覆盖率门禁通过**。覆盖率工具有 Vitest 补丁版本告警，但生成了真实完整 JSON，没有修改依赖或放宽断言。

首次根 typecheck 输出 6 个新测试夹具缺少 required recentProjects 的错误，停止旧轮后补齐输入；最终完整 `pnpm typecheck` 退出 0。`pnpm lint` 退出 0（173 warnings / 0 errors）；`pnpm architecture:check --changed` 最终 0 violations，未更新 baseline。一次测试格式化后超出 300 行的架构失败已通过复用局部 fixture 设置修正，最终门禁恢复通过。

`node scripts/licenses.mjs notices` 退出 0，仅刷新四个已修改 package.json 的输入 hash，声明正文无变化；`readVerifiedNotices()` 新鲜度验证通过。另运行严格 `requireComplete:true` 探测时，因基线已有的 19 项材料待补齐而失败；该清单本次未变化，不将严格完整性写成通过。

## 发布与限制

仅部署自建手机 Pages：`https://remote.mikiko.ai`，部署 `https://8fe0dd3f.mikiko-remote.pages.dev`，入口 `index-DuKkTtce.js`，自建协议仍为 1。没有发布 relay/其他云服务。提交内手机截图已遮蔽任务标题和账号标识。

未执行真实账号 reset/claim、模型或图片搜索消费。未测试实体手机、蜂窝弱网、Windows 原生进程回收。官方 Helper 的真实权限与动作能力仍需兼容 Mikiko 身份的 producer；当前仅完成诚实的构建不可用提示。

## 最终真实界面补证

旧库升级：WDIO 两轮均在 macOS 拒绝读取 Documents 下 immutable app 入口时收到 EPERM，未进入用例，不能记为通过。改用同一隔离旧库 fixture 的真实 Electron shell + CDP，验证初始不存在 projects 表、迁移后 3 项目/3 roots/2 任务、置顶与 cwd、空项目及刷新后顺序一致。canonical 用例仍保留 pending，证据与失败日志见 R1 报告。

日常 Dev 通过标准 `mise exec -- pnpm dev:desktop` 完整重构建启动，同一正式 profile 显示 21 个项目，启动遮罩消失，侧栏/后退/前进每项唯一。电脑控制显示 build-unavailable 且无误导启动文案/授权按钮。真实语音菜单可打开，未改选择或开关。四个 Office MCP 的 data-mcp-status 均为 connected；PDF 面板显示打开文件界面，没有原 MCP connection unavailable 错误，截图 `desktop-pdf-panel.png` 不含用户文档。通过真实会话菜单新建独立窗口后，应用区出现 18 个插件入口，点击查看全部插件显示 plugin-store-root 且无 plugin-store-error；验证后仅关闭本次新建窗口。

官方账号真实 UI 复测又发现无效合成团队 scope。恢复前先取得同 profile 历史个人选择和后续精确夹具 scope 写入时间的证据，并备份原设置；通过 SettingService.update(expectedAccountSettings CAS) 仅恢复 BigModel 个人连接，保留凭据、其他 family 和领域设置，走既有同步通知。具体账号/范围/备份源仅存私有目录；这是对既有错误状态的受控恢复，未新增旁路写者。同一 Host 公共权益快照现已返回 authenticated/subscription/quota 均有效，个人供应商 current/available/entitled 均为 true。真实 BigModel 卡片显示当前套餐和额度，无获取失败，GLM 模型目录存在。官方图片 MCP 只读 initialize 返回 HTTP 200/SSE 并成功初始化，当前个人账号两类身份头均完整；未执行 tools/call，探针 session 已关闭。随后通过原刷新/连接入口恢复 App 运行时，父任务独立读取 image_search 的 data-mcp-status 为 connected。桌面结构化证据见 desktop-verification.json。

## 验收结论

基本达到本次 Dev 回归修复的验收目标，保留上文明确限制。真实原生 Helper 未恢复，不把不可用提示等同于权限修复；WDIO 框架门禁受 OS 文件权限阻塞，不以 CDP 补证冒充该 runner 通过；全文件覆盖率低于统一默认阈值的项如实列出。交付是本地修复与可人工复测的 Dev App，没有推送分支或发布桌面安装包。

## 当前手机复连的额外检查（尚未验收通过）

当前 Host 首次复测有探针重复 bind 和页面 429，不能据手动请求 200 推断同次页面已成功绑定。去掉并发探针后，单页真实 bind 200、phone/signal WS 打开、Root/输入框显示并进入 P2P；约 14 秒后 ICE 失败，回退又出现 1006/4002 desktop-offline。此轮没有第二次 bind。正在结合既有自建 relay 部署日志定位；当前不能将稳定复连标为通过，不据此盲改 source 或发布 relay。先前生产页正常渲染证据与本轮恢复问题分别保留。
