# Computer Use 发布前实际验收复查

结论：**实际系统功能验收仍被权限阻塞，不能计为全部通过。当前预览也未接入桌面安装包发布链路。** 本次没有修改冻结的原生应用、构建身份或用户设置。

## 冻结应用的自身权限

通过独有 namespace 调用最终 Mikiko `.app` 的 `doctor --json`，走正常 LaunchServices app-agent 代理。明确没有使用禁代理时的直接子进程权限快照，没有打开权限引导或请求/绕过系统授权。

- 应用：`.cache/mikiko-computer-use/arm64/release/Mikiko Computer Use Dev.app`。
- Bundle ID：`dev.mikiko.computer-use.development`。
- Build identifier：`7ff118070543ba2998ddc91c66d227e0f05a5d905c987b7cf6e367a8aa64cb49`。
- 真实 app-agent 返回：`accessibilityTrusted:false`、`screenCaptureGranted:false`、`allGranted:false`；`missingPermissions` 为 `accessibility` 和 `screenRecording`。

因此本次不继续执行受控窗口 smoke：截图、AX query、set_value 和状态读回不能记为通过。前次真实 SDK smoke 在工具发现后由 `get_app_state` 明确返回辅助功能权限缺失，历史报告仍为 `/tmp/mikiko-computer-use-smoke-cLFhzE/report.json`。系统权限补齐后，应使用同一冻结应用重新执行受控 fixture，不能从当前自动化或构建成功推断功能通过。

本次只创建独有 namespace 下的 agent。清理先通过精确 socket 的 `agentInfo` 验证 bundleURL、bundleIdentifier 和 buildIdentifier，再发送 `terminate`；返回 `ok:true`。随后确认该 PID 已退出，socket 已移除，没有按进程名清理其他应用。

本次机器证据：`/tmp/mikiko-ocu-release-permissions-6Fzwjj/report.json`；包含权限快照、身份校验和退出/socket 清理结果。不包含用户应用内容或截图。

## 桌面安装包覆盖范围

当前 `release-desktop.yml` 不构建或打包这个新预览的 native `.app`，也没有把其 gateway 配置成随包默认后端。依据为：

1. `.github/workflows/release-desktop.yml:162` 仅调用 `pnpm bundle:desktop`。
2. `packages/desktop/scripts/bundle.mjs:735` 依次运行桌面的 `prepare:runtime-assets`、`build` 和 electron-builder；没有调用新 native builder。
3. `packages/desktop/scripts/prepare-runtime-assets.mjs:32` 列出的运行资产准备只有 agent、原 producer 条件下的 Windows CUA helper、搜索工具、可选导入 helper 和 macOS window-bounds；没有 Mikiko OCU builder。
4. `packages/desktop/electron-builder.config.js:602` 的 files 入口为桌面 out、package.json 和运行依赖；`:730` 的 extraResources 只为已存在的真实原 producer 挂 macOS CUA helper，没有新预览应用、gateway 或本地 MCP 配置映射。
5. 新原生应用当前只输出到 Git 忽略的 `.cache`（`.gitignore:32`），gateway 仍要求显式绝对路径 `MIKIKO_COMPUTER_USE_BINARY`（`packages/computer-use-open/src/native.ts:9`）。桌面 package/runtime 入口没有引用新包或预览 builder。

所以即使正常桌面构建、公证、官网和更新 feed 全部成功，也不能据此声称新 Computer Use 预览已随安装包发布或可开箱使用。安装包的现有官方占位判定没有被此预览替换。此结论来自源码只读检查；本次没有更改发布链路。
