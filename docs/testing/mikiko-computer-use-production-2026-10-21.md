# Mikiko Computer Use v1.1.4 功能验收

用户已批准正式随包集成、真实鼠标拖拽及真实测试，完成前不创建 tag。回滚锚点 `33a8ccde`，更早实验锚点 `c41c6ba7`。本报告只记录当前源码证据；预生产全量回归另见 `v1.1.4-pre-release-validation.md`，不将旧结果冒充新实现验收。

## 要求与测试对应

| 要求                                                   | 自动化                                  | 真实验收                                                |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------- |
| 默认关闭、只准入本地主会话、session/workspace/turn隔离 | gateway准入/控制器、真实SDK stdio       | 隔离Electron启停及准确授权路径                          |
| 先观察、本回合AX/截图、过期/远程/子代理拒绝            | gateway契约、MCP可信metadata            | stop后旧观察拒绝                                        |
| 自身原生权限、独占控制、正确升级/退出                  | Swift lease/lifetime、资源/权限adapter  | 原生doctor、竞争/非owner/EOF、签名peer升级拒绝          |
| AX/截图/输入正确且不重复副作用                         | 原生capture/checked-action、gateway SDK | 自有随机bundle Cocoa窗口状态与截图读回                  |
| 真实鼠标拖拽、取消清理、拒绝过期/遮挡目标              | Swift拖拽/geometry与取消测试            | 自有NSView down/drag/up、提前取消后无后续移动且释放一次 |
| 双架构随包、独立gateway、签名链                        | builder/packaging契约、依赖闭包检查     | arm64执行、x64交叉构建，正式CI公证与安装包验证另记      |

## 已执行的源码测试

- gateway SDK/契约58/58；六文件，包含发现后关闭只读连接、空闲重启后新连接、disposal迟到结果和失败probe清理。`/tmp/mikiko-cua-gateway-final.log`。
- gateway三行为文件（admission/controller/production）V8单元覆盖：lines98.18%、statements96.77%、branches91.01%。重跑当前全套覆盖见 `/tmp/mikiko-cua-unit-coverage/coverage-summary.json`。该数字不代表全项目、Swift或E2E覆盖。
- 当前权限/资源/UI及electron-builder安全测试23/23，`/tmp/mikiko-cua-ui-service-final.log`。jsdom canvas未实现提示，不作为原生截图证明。
- Node构建/打包/lease/lifetime及smoke harness20/20，`/tmp/mikiko-cua-node-final.log`。签名单测使用明确的模拟签名字段，正式签名另由真实codesign验收。
- CLI当前MCP两个调用方文件66/66及类型图32/32再次通过（`/tmp/mikiko-cua-cli-mcp-final.log`、`/tmp/mikiko-cua-cli-typecheck-final.log`）；更早扩展MCP85/Core72/bootstrap61均通过。clean pre-push另记。
- 根typecheck已通过；根lint为0错误、174项既有warning。最终源码冻结后复核。
- 最终v7的Swift11/11通过：2 capture、4 checked-action、5拖拽/取消/geometry。真实手势取消另见下表，不能用Swift通过替代。

## 真实验收与发现

用户已为正式 `dev.mikiko.computer-use` App手动启用两项权限；重新添加AX条目后，自身doctor真实返回accessibilityTrusted=true、screenCaptureGranted=true、allGranted=true。所有候选先Developer ID签名再启动，无TCC修改、无外部宿主权限替代。结果支持旧签名授权记录失效的判断，未读取TCC内部requirement，不将此推断写成已证明的数据库根因。

| 场景/缺陷                                  | 证据与修复                                                                                          | 结果                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 窗口处于台前调度缩略/显示器外，截图无image | fixture先等待自身active、完整窗口与真实显示器相交；native缺image明确失败，不伪造                    | 真实截图及AX通过                                                                               |
| 短AX查询预算导致一次click产生3次副作用     | wire确认只发1次；mutation独立2秒确认预算，发送后未确认立即停止，不启发式重发                        | 200ms按钮1次成功；3000ms错误但仅1次副作用，`/tmp/mikiko-computer-use-smoke-VGkDCl/report.json` |
| Cmd+A后type_text旧AX优化追加               | 删除读改写追加，只用已有按PID Unicode键盘路径                                                       | 中文+emoji精确替换通过                                                                         |
| 后台app_post拖拽0事件                      | 用户明确选择真实鼠标路径；生产drag单独HID投递，不开放其它global/sky模式                             | 最终随包gateway及正式路径Helper完整手势收到真实down/drag/up                                    |
| Dock台前调度全屏可穿透窗口造成遮挡误判     | 诊断确认com.apple.dock、layer20、1512×982；改为系统AX实际命中准确窗口，同时核验CG PID/id/未变bounds | v6真实拖拽通过；不放宽目标约束                                                                 |
| SDK取消但同步proxy仍完成30步               | `/tmp/mikiko-cua-visible-drag-smoke6.log`真实失败；stdio关闭stdin后proxy正在等request，EOF未传播    | 已补独立EOF monitor，shutdown仅own socket；v7真实复测通过，提前停止并仅释放一次                |
| 发现连接跨idle restart失效                 | read-only probe用完关闭，动作连接首次调用才建                                                       | 真实“发现→idle restart→首次观察”已在v6通过                                                     |

最终v7（arm64 build `8a86aae6b2fc94f850a548328f9ed4eaa6171d0930e7e97bce6dc0ec75c552df`）真实socket11项、签名升级7项再次通过：`/tmp/mikiko-cua-protocol-production-final.log`、`/tmp/mikiko-cua-upgrade-production-final.log`。x64同源码交叉构建并真实Developer ID签名成功，不声称在arm64执行x64动作。

最终正式路径Helper + 随包独立gateway完整真实smoke通过：`/tmp/mikiko-cua-packaged-actions-final.log`、`/tmp/mikiko-computer-use-smoke-V6iPVD/report.json`；200ms延迟按钮仅1次、中文emoji输入、12工具、实际截图、拖拽及取消/stop均通过。3000ms按钮未确认但仅一次副作用：`/tmp/mikiko-cua-uncertain-click-production-final.log`。这些动作仅针对随机PID/bundle/nonce的自有Cocoa窗口，未操作用户项目/账号。

最终隔离Electron设置用例1/1通过（9.7s，0模型请求）：`/tmp/mikiko-cua-electron-production-final.log`，run `mikiko-cua-v114-final-visible-drag`。覆盖默认关闭、启用后真实权限及准确路径、空闲重启、composer开关、窄屏/主题与禁用。pending用例不未经人工review晋升正式CI。

双架构资源实际stage通过；独立gateway在无node_modules临时目录发现/拒绝缺上下文/EOF退出通过，`/tmp/mikiko-cua-standalone-final.log`。真实打包hook对两个架构完成native binary和完整子App签名，校验runtime/secure timestamp/identifier/architecture以及前后摘要：`/tmp/mikiko-cua-package-signing-final.log`。这是本地随包布局与签名证据，正式CI父App公证仍待进行。

## 当前结论与发布门禁

正式Computer Use功能测试及本机可执行的真实验收通过；其他功能的预生产完整回归保留于独立报告。根类型、lint、架构和声明hash均通过，lint保留174项既有warning。严格许可证完整性检查的既有sharp/libvips人工清单未被放宽，详见预生产报告。

最终独立评审已完成，修复了gateway覆盖drag说明的问题；已先记录真实SDK目录断言失败，再修复并58项通过，最终独立bundle目录也确认真实鼠标/焦点说明存在。取消/lease、准确窗口及嵌套签名未发现额外重要问题。clean pre-push与commit/push/tag尚待执行。正式发布还必须验证五平台安装包、双Mac Accepted与App/DMG staple和ZIP、官网及stable清单。未完成这些发布验收前不称发布完成。
