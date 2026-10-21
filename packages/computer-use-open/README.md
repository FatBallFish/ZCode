# Mikiko Computer Use 本地预览

这是独立 MCP 后端，不是官方 CUA producer。首轮支持 macOS 14+，需要 Swift 6.2 和 Node 24。原生固定版本、权限模型和正式接入计划见 [技术方案](../../docs/plans/2026-10-21-mikiko-open-computer-use-design.md)。

```sh
mise exec -- node scripts/build-mikiko-computer-use.mjs
mise exec -- pnpm --filter @mikiko/computer-use-open build
```

构建不会启用插件或写入用户 MCP 设置。原生应用位于 `.cache/mikiko-computer-use/<arch>/release/Mikiko Computer Use Dev.app`；其进程和权限身份属于 Mikiko。原生配置默认 `~/.mikiko/computer-use/config.json`，现有项目数据根目录不变。

先运行受控测试：

```sh
mise exec -- node scripts/smoke-mikiko-computer-use.mjs --prepare
# 以下两个参数使用构建产物的绝对路径。
mise exec -- node scripts/smoke-mikiko-computer-use.mjs --execute \
  --native '/absolute/path/Mikiko Computer Use Dev.app/Contents/MacOS/mikiko-computer-use' \
  --native-app '/absolute/path/Mikiko Computer Use Dev.app' \
  --gateway '/absolute/path/packages/computer-use-open/dist/server.js'
```

测试仅操作本次创建的随机身份文本框，检查截图、AX、输入和独立读回，并清理测试窗口。截图及报告位于 `/tmp`，不提交真实用户内容。缺少系统权限会如实失败；需要在系统设置中手动授予该 Mikiko 应用辅助功能及屏幕录制权限，不能依据父进程或旧 OCU 的授权判断。

手动接入时复制 `mcp.example.json`，替换 Node、gateway 和 native 的绝对路径，再通过 Mikiko 的 MCP 设置导入。默认 allowlist 是空数组，不会暴露任何工具。测试完成后才将 `MIKIKO_COMPUTER_USE_ALLOWED_APPS` 改为需要控制的测试应用 bundle ID JSON 数组。`isolation=session` 必须保留；只支持主会话的本地路径 workspace，远程与子代理被拒绝。每回合必须先成功调用 `get_app_state`，`query` 不替代完整观察。

当前仅是受控预览：尚未接入 Host 全局控制 lease、即时回合结束钩子、内置电脑设置 UI、正式签名公证及跨平台分发。不要把 session 隔离当成物理桌面独占。当前内置 Computer Use 的占位检测保持不变。

```sh
mise exec -- pnpm --filter @mikiko/computer-use-open test
mise exec -- node --test scripts/test/mikiko-computer-use-build.test.mjs scripts/fixtures/mikiko-computer-use/smoke-runner.test.mjs
```

## Bundled production entry

`dist/production-server.js` is the production entry; packaging emits a standalone
`Resources/computer-use/production-server.mjs`. The existing opt-in Computer Use
plugin selects this backend only when Desktop supplies its verified native App,
executable and gateway paths. This entry never emulates the official NodeREPL
producer. Windows/Linux and macOS below 14 do not expose this backend.

Production discovers `list_apps`, ten narrowed native tools and `stop`. Use the
exact application bundle ID, observe with `get_app_state` before acting, and use
fresh observations each turn. `query` alone cannot authorize actions. Global/sky
input, virtual displays, subagents and remote/mobile delivery remain unavailable.
All calls retain existing MCP approval and trusted host context requirements.

The runtime sends `notifications/mikiko/turn-ended` from its finally boundary;
matching completion retires the turn and closes that session's native connection.
`stop` closes only the current native connection and clears observations, while
retaining the session/workspace binding. Reuse requires a fresh observation.
Cancellation and uncertain transport errors permanently invalidate that gateway;
side effects are never replayed. The native App-agent owns the global lease and
returns busy for a competing controller.

Real acceptance uses only a disposable synthetic Cocoa fixture:

```sh
node scripts/smoke-mikiko-computer-use.mjs --production --execute \
  --native '<absolute App path>/Contents/MacOS/mikiko-computer-use' \
  --native-app '<absolute App path>' \
  --gateway '<absolute gateway path>'
```

This verifies real screenshots and AX state, `set_value` readback from the fixture,
button clicks, keyboard input and stop invalidation. It records blocked separately
from passed; the signed Mikiko App itself must hold Accessibility and Screen
Recording permissions. Unit fixtures and a successful doctor preflight do not
replace this acceptance.
