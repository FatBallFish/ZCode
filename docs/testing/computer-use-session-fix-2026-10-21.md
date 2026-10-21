# Computer Use会话工具修复与复测

## 两个已确认根因

1. `resolveStartupPlugins`只执行插件发现，未像插件管理入口一样调用`bindOfficialPluginMcpRuntime`。新Computer Use server缺少生产后端标记，被旧CUA过滤逻辑移除。已启用插件和已授权Helper均不能证明会话拿到了工具。
2. 补齐绑定后的真实会话发现第二个问题：网关只有顶层启动副作用，没有插件宿主要求的`main()`导出。日志为`Plugin host failed: Plugin server does not export main().`，随后`CONNECTION_CLOSED`。发现可能短暂成功，工具调用不可靠；独立网关测试未覆盖该宿主合同。

修复：启动路径复用现有官方插件runtime绑定；网关导出无import启动副作用的main，宿主调用和直接启动共用同一启动/关闭逻辑。直接启动比较真实路径，兼容macOS的/tmp、/var和用户符号链接。旧CUA过滤、默认关闭、缺资源禁用、权限、owner/lease和用户配置保持既有合同。

规格与事件顺序见[工具链规格](../../apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md)。没有增加启动等待、失败重试或原生动作重放。

## 红绿回归

- 启动链路修复前：新增6项中3项失败，覆盖运行时工具缺失、缺资源未禁用及模型拿不到工具；修复后6项通过。
- 网关入口修复前：import副作用和缺main的2项合同失败；符号链接入口另复现`Connection closed`。修复后相关3项通过。
- 完整会话回归从真实startup与runtime配置进入真实stdio MCP，脚本模型收到工具、发起调用、读到返回值。MCP夹具实现现代2026-07-28协议并显式导出main；记录每个进程PID，保证每个宿主进程只调用一次main。协议探测可启动独立进程，不能误当同一进程重复启动。
- 夹具只证明接线，不能当作真实原生操作证据。

## 正式Helper的真实会话复测

使用本机已安装1.1.4的签名Helper，以及由当前源码生成的临时gateway测试模块。进入当前源码`createZCodeApp`，走插件发现/绑定、runtime旧CUA过滤、实际CLI插件宿主、MCP工具注册、脚本模型工具调用、原生Helper和回合清理全链路。

连续3次独立会话均通过：

- 正式Helper自身doctor：AX=true、ScreenCapture=true、appAgent=true，确认与目标App路径一致。
- 首次模型请求实际包含12个Computer Use原生工具。
- 脚本模型调用真实`list_apps`，工具结果success=true，0个ToolCallError，结果进入第二次模型请求；没有真实LLM请求或项目内容出网。
- 使用隔离配置、内存Session/Event store，只在内存检查原生结果，不保存应用列表或窗口内容；未修改用户插件配置、项目数据或TCC。
- 证据：`.cache/mikiko-cua-startup/native-session-fixed-{1,2,3}.json`及`/tmp/mikiko-cua-startup-native-session-fixed-{1,2,3}.log`。

早期失败保留在`.cache/mikiko-cua-startup/native-session-proof-1.json`及`/tmp/mikiko-cua-startup-native-session-debug.log`，是发现第二个缺口的证据。测试没有通过重试掩盖它，修复主入口后重新执行独立会话。

## 验证结果

| 验证                                      | 结果                                                     | 日志                                                                                                |
| ----------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| CLI启动/插件绑定/runtime/技能及Core工具桥 | 7文件152项通过                                           | `/tmp/mikiko-cua-startup-regression.log`                                                            |
| Computer Use gateway合同                  | 7文件61项通过                                            | `/tmp/mikiko-cua-entry-green.log`                                                                   |
| 仓库外临时gateway直接运行                 | 12工具、缺上下文拒绝、EOF子进程关闭通过                  | `/tmp/mikiko-cua-startup-direct-gateway.log`                                                        |
| 根类型检查/lint                           | 通过；lint0错误、174项既有warning                        | `/tmp/mikiko-cua-startup-typecheck.log`、`/tmp/mikiko-cua-startup-lint.log`                         |
| CLI类型检查/lint                          | 32/32任务成功；lint0错误、74warning、接纳9项上游行数诊断 | `/tmp/mikiko-cua-startup-cli-typecheck.log`、`/tmp/mikiko-cua-startup-cli-lint.log`                 |
| 架构                                      | 改动前后0 violation                                      | `/tmp/mikiko-cua-startup-architecture-before.log`、`/tmp/mikiko-cua-startup-architecture-after.log` |

本轮仅源码、测试及本地commit。测试时临时转译gateway JS，不生成或修改正式App/DMG/ZIP，不签名/公证、不改已发布tag和线上资产。已安装1.1.4的代码未改变。本次验证聚焦会话工具恢复及真实原生只读调用，没有重新验收12个工具的全部系统操作或新版安装包。
