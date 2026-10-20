# Desktop / Web 集成检查点

范围：`41fbf6fd` Mikiko 输入与上游 `0a1fc56d`（3.16.1）、`075fde84`（3.16.2）的 Desktop/Web 融合。各轮结果按检查点列示；不将单元测试等同于跨平台或生产服务验收。

## 实现落点

- Desktop/Web 文本冲突已逐项处理。采用 Source Server 的连接/Profile/项目导航与全转发服务集合；原 SSH 本地 OAuth/JWT 混装集合不恢复。宠物、皮肤、语音、CDP、文件默认应用规则和独立会话窗装配保留。
- 手机保持自建 `remoteControl`（Mikiko ID、设备认领、票据、P2P）与原 HMAC 扫码协议。Main manager 保留自建认证，适配上游通用项目导航、Source session 换代、bridge generation、ACK replay 和恢复。Web 同样复用新版通用恢复、项目草稿和 task-view epoch，不装配 Relay V2 device/token/transport。
- 原二维码轮换仍经 `RemoteControlRefreshTicket → service.refreshTicket()`；CodingPlan 账号退出不撤销独立自建扫码设备。被明确排除的 Relay V2 manager 产品集成测试移除；纯 V2 协议/入口代码及合同测试保持隔离，不用于自建链验收。
- 自建 WS 保持毫秒 client_ts、10 秒心跳与 30 秒 ACK。真实测试发现上游删除旧常量会使 watchdog 立即超时，已通过 shared 兼容合同修复；serializer 不再依赖 Relay V2 消息类型。
- 新未读上报携带任务身份集合，Main 校验后按跨窗口并集计数。保留旧 scope 去重兼容与回归；不同/重叠远端可见集合不按数字 max 推测。托盘和 Windows overlay 仍消费同一应用计数。
- Source Directory 默认索引路径使用 `.mikiko`；新外显环境开关与存储键使用 Mikiko。分享页“返回首页/下载”修正为现有自建品牌服务。安装包品牌元数据修正为 Mikiko。
- TS6/noUncheckedIndexedAccess 兼容修复包含宠物 bounds/主题 payload、Electron 正式跨 Space setter、voice chunk/waiter 类型、当前 App Info.plist 读取、spawn/缺失导入和已重命名辅助窗入口。相关二开真 IO 测试通过。

## 实际验证

| 验证                                                        | 结果                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 自建 Desktop/Web WS、认证、preload、未读                    | 7 文件，88 测试通过                                                                                                    |
| Manager + Web home-only + bridge recovery                   | 3 文件，76 测试通过                                                                                                    |
| 额外慢配对取消回归                                          | 先失败；修复后 manager 完整 61 测试通过                                                                                |
| 额外 CodingPlan 与自建扫码隔离回归                          | 1 测试通过（其余 61 筛选跳过）                                                                                         |
| 皮肤/宠物/语音 Node 原生测试                                | Node 24.14.0，65 测试通过                                                                                              |
| 平台/lifecycle/preload/未读/runtime                         | 4 文件，87 测试通过                                                                                                    |
| Web 旧 HMAC terminal transport                              | 27 测试通过                                                                                                            |
| 分享渲染与通用 Web bridge recovery                          | 2 文件，30 测试通过                                                                                                    |
| Web home-only 与通用 bridge recovery（最终同 owner 适配后） | 2 文件，16 测试通过                                                                                                    |
| 新品牌 UI 与隔离入口                                        | 36 测试通过；其余 11 新品牌列表/登录断言在前次运行通过                                                                 |
| 宽领域 12 文件                                              | 首轮 264 通过、3 失败；失败涉及被自动合并删除的测试导入和旧品牌预期，修复后对应 2 文件 26 测试通过；未将首轮写成全通过 |
| Web TypeScript                                              | 通过                                                                                                                   |
| Desktop Host TypeScript                                     | 通过                                                                                                                   |
| Desktop Main / Preload TypeScript                           | shared 重建后 Main / Preload 均通过                                                                                    |
| 作用域 Lint（最终）                                         | 475 文件，0 错误、14 警告                                                                                              |
| 格式 / git diff --check                                     | 已修改文件 oxfmt 与 diff 空白检查通过                                                                                  |
| architecture --changed                                      | 合并中曾因 origin/main 比较基线把二开历史和 dist-pages 计作新增而失败；由主任务统一处理，不改 policy/baseline 逃避     |

以上测试有重叠，不将测试数量相加为独立覆盖数。测试使用临时目录/本机 WS fixture，没有访问个人正式数据库；没有执行生产账号/真实手机/OS Shell 角标的人工 E2E，也没有签名、部署或发布。

## 下一检查点

1. 本轮 shared 声明重建及 Desktop Main/Preload/Web/E2E 子工程型检已完成；全仓 typecheck/lint/架构门由主任务收口。
2. 合入最终 3.16.2，复核 SourceServer、Web 恢复与品牌改动是否有新增适配。
3. 由主任务运行桌面/手机真实交互 E2E、迁移与产物验证。保持未测试环境明确列示。

## 全仓验证后的第二轮修复

- 定向重现最初 14 文件的33失败，区分旧产品品牌预期与真实实现问题；普通产品端点断言迁至自建服务，CodingPlan 官方购买页的安全断言保留，由 shared 独立官方允许列表恢复。
- 数据库启动 relay 修复两处真实生命周期问题：不对陌生 IPC sender 调用 Electron API；Host 退出立即撤销准入 ID，主窗口关闭不能撤销仍供独立会话窗共享的 Host relay。新增共享 Host 关闭回归。
- 移动项目/目录/未读 fixture 改为真实 HMAC 注册、challenge/response 和双向转发，明确拒绝 V2 token 接口。用例继续保留；Web fixture 通过自己持有的 HTTP server listen(0) 分配随机端口，再挂 Vite middleware/HMR，避免固定5173占用及释放端口竞态。启动失败和结束均清理本次 relay/子进程并恢复环境。
- Web 开发依赖扫描只以当前 index.html 为入口，避免扫描历史 dist-pages 快照。作用域旧宽泛 eslint-disable 已移除。
- 第二轮定向10文件87测试通过；最后 WindowChrome/数据库 relay/HMAC fixture/Web配置4文件52测试通过，包含实际 Web index HTTP读取和 HMAC socket 转发。
- shared 声明重建后 Desktop Main、Preload、Host、Web、Desktop E2E TypeScript 均通过。原 root package-lock 版本和macOS doctor脚本故障由主任务修复。
- Vite serve阶段的PDF CMap emitFile警告已报告UI owner；不把警告当作运行失败，也不静默吞掉。
- 上游“官方CodingPlan账号驱动RelayV2启停”的两份 manual-review E2E不属于自建远控验收，不声称它们已通过；最终台账需明确排除，并用Mikiko ID认领/撤销/刷新票据用例验收。

第二轮最后一次 shared 重建后 Desktop E2E 型检无错误；新采用的 auth-ui / self-hosted-remote
合同测试2文件2测试通过，Web型检无错误。该轮 scope Lint 491文件0错误15警告，
Git空白检查通过。各轮统计存在交集，不汇总成唯一用例总数。

## 最终 3.16.2 与原生 Electron 验收准备

- 最终 Desktop/Web 定向7文件108测试、Windows原生overlay像素20测试通过；保留跨窗口任务身份并集与上游Windows10/11 1x/2x红点渲染。
- Source Server下载改用自建 `agent-dl.mikiko.ai/mikiko/electron/releases`，descriptor与server压缩包使用Mikiko名称。3文件50测试通过，包含真实loopback HTTP descriptor/archive下载、SHA和缓存断言；构建CDN前缀19测试通过。
- 官方账号Web callback修复BigModel `authCode` 和canonical `/remote/v4[/]`，仍要求state且不装配V2；新旧E2E bridge flag同值兼容。callback、Vite、隔离fixture seeder共3文件31测试通过。
- 远端提示附件公开根与真实落盘统一 `.mikiko`；先观察2个回归失败，修复后2文件11测试通过。历史绝对附件路径保留按原路径读取，不做批量移动。
- INT-E2E-01/02/03新增为pending候选，明确隔离HOME、case-local replay、真实UI动作与Git/SQLite/磁盘/Host/wire证据，不使用个人profile、生产账号、真实麦克风或模型下载。3份fixture检查与Desktop E2E型检通过。
- 首次真实native runner在构建前暴露品牌测试变量契约错误：wrapper/reporter只写旧run键，新WDIO读新键即失败。已补新品牌输入优先与双写同值回归（先1红23绿，修复后24/24通过），直接WDIO reporter同步初始化新旧run/artifact键；E2E型检及定向Lint通过。该启动失败不计为Electron功能通过。

## 原生 Electron 真实交互结果

2026-10-20/21（Asia/Shanghai），Darwin arm64，Electron41.0.3/Chromium146.0.7680.80，私有ChromeDriver146.0.7680.165。
先完整构建Desktop Main/Host/Preload/renderer及CLI bundle，后续仅测试fixture/helper修订时复用同源构建；未触碰全局driver或个人正式profile。

| Case       | 实际断言                                                                                                                                                            | 最后通过 run ID                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| INT-E2E-01 | 真实UI创建detached worktree并首次发送；Git root HEAD不变、asset拷贝、SQLite cwd、根项目树归属；打开和关闭独立会话窗保持同一Host PID和会话内容                       | `desktop-e2e-20261020160055908-p91101-8f78a70c1ac4f202` |
| INT-E2E-02 | combined菜单选副模型/max；实际loopback请求模型一致且主请求1次；SQLite cwd、完成后1turn/1step和统计popover；Main麦克风权限denied时实际voice error/关闭保留未发送草稿 | `desktop-e2e-20261020160055908-p91101-8f78a70c1ac4f202` |
| INT-E2E-03 | UI新建/应用自定义皮肤，实际theme.json与刷新前后localStorage相同；自建远控dialog和配置disabled状态、0 provider请求                                                   | `desktop-e2e-20261020154250848-p44240-56bd4f4842d4e53c` |

各case均1测试通过、进程exit0。证据在 `packages/desktop/.e2e-artifacts/<run ID>/INT-E2E-0N.json` 与同名PNG；同目录summary、网络捕获和runtime日志可复核。fixture仅loopback replay，未访问付费模型、生产账号/relay或真实麦克风。

先前运行没有冒充通过：INT03首次是测试fixture遗漏上游新增`localePreference`导致英文selector失败，补齐明确英文偏好后UI入口正常；INT01先修WDIO复合text selector，再修`electron.execute`不支持首参解构的fixture问题，保留Git/SQL/Host断言。runner新增cleanup key兼容，退出所有权回归WDIO，失败HOME不被spec提前删除。

测试后复核发现两项孤立产品修复：历史已物化的同远端HOME `.zcode` 附件引用只读识别，避免误作Host本地文件重传，cleanup/janitor仍只认`.mikiko`新根；cron/voice utility外显名改`mikiko-cron-scheduler`与`mikiko-voice-engine`。两项都先观察红灯；最终附件/transfer/cron/voice/Host probe/runner共6文件48测试通过。父完成最终all-runtime与产物freeze后，重新完整构建Desktop+CLI并复验INT03，1测试通过、runner exit0（总131.471秒，真实UI25秒）；JSON确认实际scheduler进程名为`mikiko-cron-scheduler`、PID46275。最终run同时重新验证皮肤磁盘/刷新持久化、自建远控配置归因和0 provider请求。INT01/02随后在同一最终out上skip-build串行复验，两spec均通过、runner exit0（真实UI共46秒），因此本3case的最后通过均对应最终frozen Desktop+CLI产物。

本3case保持pending，未人工review，不自动promote或Docker admission。不覆盖生产OIDC/Mikiko设备认领、真实手机P2P、真实语音识别/模型下载、Windows/Linux Shell、签名安装或发布。

最终日志：`/tmp/mikiko-int03-electron-final-frozen.log`、`/tmp/mikiko-int01-int02-electron-final-frozen.log`。最后scope Lint零错误/警告，Desktop E2E型检与architecture通过；全仓最终typecheck、lint、架构门由父任务统一记录。

最终通过的两个 run 目录已逐文件 SHA-256 校验后复制回主工作区，长期证据位置：`/Users/fatballfish/Documents/Projects/ClientProjects/ZCode/packages/desktop/.e2e-artifacts/upstream-v3.16.2-integration/`。原测试 cwd 继续保留在 JSON/日志中作为执行上下文。
