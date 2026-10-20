# 上游功能取舍与二开保留台账

来源固定为 `source-manifest.json` 中的 SHA。`adopted` 为采用上游实现，`adapted` 为按当前二开合同适配，`excluded` 为用户明确不采用。文件级哈希对账只能证明来源，不能代替功能验收；实际结果见 validation-report.md。

| 功能域                          | 处理     | 集成结果及约束                                                                                                                                    | 主要验证入口                                                                      |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ProjectDirectory/项目侧栏       | adapted  | 使用上游目录/项目 owner；移植工作树显示聚合、路径菜单、置顶层级与拖出入口；聚合不改变 cwd/identity                                                | projectSidebar / projectUpgradeOrder / worktree；桌面集成场景                     |
| SQLite 启动迁移与 task facts    | adapted  | 采用迁移屏障、校验与 CLI 事实；Mikiko 数据目录引导前置，保留历史导入/归档和工作树清理合同                                                         | schema check / storage-migration / importedCodexSessions                          |
| Composer/模型/思考档位          | adapted  | 采用上游选择/菜单与工作位置修复；保留 ChatGPT、Sub2API、MikikoCC、语音与统计                                                                      | composerModelThinking / modelProviderTargetResolution；真实菜单测试               |
| side-pane 完整视图              | adapted  | 采用上游完整视图；保留 custom 分屏与拖出窗口，使用同一布局/DnD owner；floating/隐藏 pane 不接收 drop                                              | sidePaneFullView / splitPaneEntryContext / workbenchDragDrop                      |
| 上游删除分屏/DnD                | adapted  | 用户要求保留的历史能力优先；只移植必要合同，未复制第二个 session/runtime owner                                                                    | sidebar-projects / session-drag-out-window specs                                  |
| 多窗口与未读                    | adapted  | 同 Host attachment；Main 聚合 task identity 并集，关闭通知上报 (0,[])，不重复计数                                                                 | desktopTrayBadge / unreadBadge / projectDirectoryNotificationGate                 |
| 手机 Relay V2 产品装配          | excluded | 生产入口继续 RemoteControlDialog → remoteControl/service → 自建 relay-server 票据链，保留 Mikiko ID、设备认领/直连、P2P；不装配 V2 token/账号门禁 | relay-server 真实 WS/票据/RPC Node E2E；旧 HMAC fixture 仅证明遗留 transport 合同 |
| 通用远控导航/取消/恢复          | adapted  | 适配到自建协议；保留桌面 continuous、手机 replayable、owner/lease 与 stale-result 防护                                                            | webRemoteControlLegacyTransport / HttpCompatibility / remote-abort                |
| Source Server                   | adapted  | 安装目录/CLI/服务/进程使用 Mikiko；旧自有安装元数据仅受控读取兼容；资源从自建下载源解析                                                           | releaseInstaller / runtimeUpdateIntegration / remoteCdn                           |
| 官方 CodingPlan 账号            | adapted  | 官方 OAuth、账号/订阅合同继续保留；产品配置/反馈/资源默认自建，专用账号配置代理与公共配置隔离                                                     | OAuth / Usage / mikikoClientConfigService                                         |
| 官方营销、积分/活动与遥测       | excluded | 不装配官方营销入口；生产遥测保持硬关闭，不用账号例外放行普通产品服务                                                                              | privacy / env / provider config                                                   |
| 插件与 Office 能力              | adapted  | 上游协议/发现修复采用；新 `.mikiko-plugin` 优先、旧格式只读兼容；不修改不透明插件 ID                                                              | plugins-protocol / manifest adapters / plugin services                            |
| 更新、反馈、分享与云配置        | adapted  | 保留 Mikiko 自建服务、签名/公证及恢复发布；Source Server 与桌面产物共用受控发布传输                                                               | update-service / mikiko-cloud / source publish fixtures                           |
| 皮肤、壁纸、桌宠、CDP、打开方式 | retained | 保留 custom 平台扩展，适配上游窗口/Host 生命周期                                                                                                  | Node unit registry 与平台定向测试                                                 |
| 新增产品标识                    | adapted  | 产品默认 env/路径/文件/服务使用 Mikiko；内部包 scope、历史 ID、第三方签名合同保留                                                                 | surface-rebrand spec / 端点审计 / 打包测试                                        |
| 架构治理                        | adapted  | 接纳新上游模块；历史豁免绑定集成前固定 blob，修改后重新受管；不刷新违规 baseline                                                                  | test:architecture / architecture:check --changed                                  |
| CUA 开源占位                    | retained | 保持当前 fail-closed 与签名互验边界，不恢复已移除内部模块                                                                                         | cua-placeholder / bundle checks                                                   |

## 验证边界

自动化使用临时数据库、隔离 HOME、loopback 服务与回放。真实官方账号登录、生产云端部署、真机录音/手机网络、跨平台安装不能由这些夹具推导为已通过。各项是否已执行及限制以最终报告为准。

## 文件来源对账

`file-review.tsv` 比较共同基线、固定上游、完整 custom 输入与当前索引的 Git mode/blob。`*-exact` 表示逐字节来源一致，`integration-adapted` 需结合本台账和领域测试理解，**不是逐行人工审阅证明**。删除也单独分类，不能因无冲突标记自动认定功能保留。

双方输入都存在而本轮删掉旧路径的七项已核对：

- 四个 Office `.zcode-plugin/plugin.json` 移至各自 `.mikiko-plugin/plugin.json`，发现入口新名优先、旧名只读兼容。
- `v4/featureSuggestedPromptRotation.ts`、`v4/featureSuggestedPrompts.ts`、`v4/officeSuggestedPrompts.ts` 移至 `draft-recommendations/`，通过该模块公开 contract 使用；Office 候选、刷新、跨 pane 去重和 Coding 候选多样性继续测试。图标改本地资源，未删除普通 Office 提示功能。

上游删除的旧侧栏/分组/未读 owner 由新项目树替代；custom 工作树、置顶和窗口能力移植到新入口。保留的分屏/DnD 源文件已重新纳入索引，不能把 stage 前的临时删除误计为最终功能删除。
