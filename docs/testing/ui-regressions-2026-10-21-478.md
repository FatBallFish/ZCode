# 人工回归 4 / 7 / 8 验证记录

工作区：原 `ZCode` 目录，基线 `custom_main@3358e20a`。不修改个人数据、不发模型请求、不启动新 Host、不提交或部署。

## 已确认原因与修复

| 项目                              | 已确认原因                                                                                                                                                  | 修复                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 4 顶部按钮重复                    | `DesktopTopOverlay` 合并后保留了两组 toggle/back/forward；外组继承 pointer-events:none，内组正常。真实 Dev CDP 只读检查确认后退节点为 2，分别为 none/auto。 | 删除外组，全部平台只保留唯一 no-drag 交互组，导航可用性 owner 不变。                                                    |
| 7 语音整理模型旧菜单              | 同一 `ModelConfigSelect` 未传会话使用的 composerOptions，因此进入旧供应商悬浮子菜单。                                                                       | 复用真实 ComposerModelMenu，候选继续取本地 ModelSelectionView，选择只写 voiceCleanupSelection，最低思考档保留。         |
| 8 独立窗口插件为空/查看全部无响应 | Root 缺 PluginUiWorkspaceProvider，导致 useOpenPluginUi 为 undefined、推荐项不挂载；同时未传 onOpenPluginMarket，按钮直接返回。无需改 Host 注入。           | 使用本窗口已有 useAppPanels 的两个动作装配 Provider 和市场回调，保留 workspaceIdentity/parentSessionId 与窗口局部面板。 |

## Test-first 与实际结果

- `desktopTopOverlayActions.test.ts`：三个平台先失败（2 vs 1），修复后各入口一次点击一次回调。
- `voiceCleanupModelMenu.test.ts`：缺 composerOptions 先失败；修复后单次模型选择只更新一次语音设置并保持 low。
- `sessionWindowPluginActions.test.ts`：修正夹具本身后，插件入口不存在、市场回调为零两项先失败；修复后接入本窗口 owner。
- 定向 Vitest：6 文件、11 项通过；V8 整文件覆盖率为 statements 63.12%、branches 52.24%、functions 36.2%、lines **67.08%**。该结果不是 95% 覆盖率门禁通过，也不代表这些大型页面的无关功能已验证。
- Node `voiceTranscript.test.ts`：5 项通过，继续使用其正确的 Node runner。
- UI TypeScript 检查实际退出 0；针对性 Lint 10 文件，0 错误/警告；格式化与 diff 检查完成。

日志：`/tmp/mikiko-ui-478-red.log`、`/tmp/mikiko-ui-8-red.log`、`/tmp/mikiko-ui-478-coverage.log`、`/tmp/mikiko-ui-478-transcript.log`、`/tmp/mikiko-ui-478-typecheck.log`、`/tmp/mikiko-ui-478-lint-final.log`。完整 V8 statementMap：`/tmp/mikiko-ui-478-coverage/coverage-final.json`；summary 位于同目录 `coverage-summary.json`。

## 浏览器验收

入口：`node --test --test-concurrency=1 packages/ui/test/browser/manual-review/pending/ui-regressions-478.test.mjs`。使用 OS 分配的独立 loopback 端口和自建 Chrome fixture，所有非夹具 origin 请求阻断并记录；浏览器与 Vite 服务均由本次测试关闭。

最终结果：**6/6 通过**，日志 `/tmp/mikiko-ui-478-browser-final-evidence.log`（补充关闭后模型名与禁用状态后重新执行）。

1. macOS / Windows / Linux 顶部按钮分别各一个，真实鼠标点击后事件序列恰为 toggle、back、forward。
2. 浅色英文 / 深色中文语音设置真实菜单切换供应商与模型，两次动作各保存一次，这两次写入仅包含 voiceCleanupSelection，最终 relay-two/low；无 effort 滑杆。关闭菜单后仍显示所选模型名，关闭整理开关后选择器禁用。
3. 两个实际 SessionWindowRoot 在独立页面挂载：均出现真实插件 Launcher；一个打开本地市场，另一个打开插件 tab，保留 identity/session，市场窗口保持原位。检查无 pageerror、无外网请求。

截图与结构化证据：`packages/desktop/.e2e-artifacts/ui-regressions-478/`（UI4 三平台、UI7 两主题、UI8 Launcher/插件页及 evidence.json）。

限制：浏览器中使用真实根组件、菜单、Provider、Launcher 和 pane/tab UI；Host/ASR 服务端口、无关聊天/Git 内容及插件市场/沙箱的重内容使用隔离夹具。本轮不验证真实 Helper、插件安装、插件沙箱执行、原生独立窗口新进程或账号/模型调用。浏览器仍记录共享 ModelConfigSelect 已有 Tooltip uncontrolled→controlled 警告，无运行异常；本次未扩展为共享提示组件重构。
