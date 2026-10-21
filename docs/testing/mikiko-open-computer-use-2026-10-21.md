# Mikiko Open Computer Use 实践验收

## 结果

开源后端可构建并接入本仓库的 MCP 链路。本轮交付独立、显式启用的本地预览，尚未完成正式内置 Computer Use 替换。真实链路已通过工具发现，首次窗口观察被新 Mikiko 应用的辅助功能权限阻塞，因此截图、输入及真实读回不能记为通过。

实践前回滚锚点：`c41c6ba7f9cde785276c329f2394bbdfa3c9de05`。当时工作区干净，创建了明确的空锚点提交；此前所有功能变更已在 `9aacca2d` 等提交中保存。实验源码目前作为后续可审阅变更保留，未推送。

## 已执行验证

使用 `mise.toml` 固定的 Node 24.14.0 / pnpm 10.33.2；原生为本机 Apple Silicon、Swift 6.2、macOS 26。

| 检查                                   | 实际结果                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| 固定上游 Swift release / Mikiko `.app` | 构建成功；ad-hoc 签名严格校验成功                                                          |
| 原生非交互 probe                       | 品牌 help、doctor JSON、MCP initialize、11 个原生工具发现成功；未执行动作                  |
| Gateway 合同测试                       | 25/25：来源/身份/目标、完整观察、截图准入、退役回合、串行、取消/超时及关闭                 |
| 真实 SDK stdio 协议测试                | 5/5：SDK2 → gateway → SDK1 → 合成原生进程；图片/错误/截断、turn-end、EOF、首次连接关闭竞态 |
| 构建/fixture 边界测试                  | 6/6                                                                                        |
| 原官方占位包回归                       | 2/2；可用性未伪装为支持                                                                    |
| `pnpm typecheck`                       | exit 0，根命令已纳入新包                                                                   |
| `pnpm lint`                            | exit 0，174 条现有警告、0 错误；新代码范围检查无警告                                       |

上述自动化共 38 项通过，不等同于实际系统输入验收。测试使用合成原生进程或自有临时窗口，没有付费模型请求，也没有对真实用户应用执行输入。

真实窗口 smoke 报告：`/tmp/mikiko-computer-use-smoke-cLFhzE/report.json`。该次完成 fixture 编译/签名、PID/bundle/title/nonce 身份校验、真实 MCP 发现 10 个预览工具；`get_app_state` 返回 `isError:true`，文本为 `Accessibility permission is required`。测试窗口已清理。新建 app-agent 通过精确 socket 的 `agentInfo` 校验 bundle 路径及 build identifier 后，`terminate` 返回 `ok:true`，没有按名称终止其他进程。

原生直接诊断曾返回 `allGranted:true`，但 LaunchServices 启动的新应用实测缺少权限，证明直接子进程诊断不能代表该 Mikiko `.app` 的 TCC 授权。

## 产物与复现

- 技术方案：`docs/plans/2026-10-21-mikiko-open-computer-use-design.md`。
- 网关及使用说明：`packages/computer-use-open/README.md`。
- 原生应用：`.cache/mikiko-computer-use/arm64/release/Mikiko Computer Use Dev.app`。
- 构建来源、hash、签名和 probe：应用同级 `provenance.json`。
- 本地可导入 MCP 配置：`.cache/mikiko-computer-use/mcp-preview.json`。其中已填本机绝对执行路径，allowlist 保持空数组；未写用户设置。
- 可提交的通用配置模板：`packages/computer-use-open/mcp.example.json`。

按 README 构建后运行 `scripts/smoke-mikiko-computer-use.mjs --execute`，即可复跑真实截图 → AX query → set_value → fixture 自有状态读回 → AX 读回。系统授权需用户在隐私设置中给上述 Mikiko 应用授予辅助功能和屏幕录制；未获授权时不绕过 TCC。

## 正式发布前仍需完成

Host 全局控制 owner/lease、即时 turn-complete/session-close 通知、内置权限/状态 UI 与原 SDK 方法映射、正式签名公证与升级授权回归，以及 Windows/Linux 各自验证。当前 session 隔离不代表物理桌面独占，预览应限定受控测试目标。

项目/账户/历史会话根目录仍为 `~/.mikiko` 下现有路径，本次没有改写。手机远控、自建云服务、智谱账号体系也没有变化。
