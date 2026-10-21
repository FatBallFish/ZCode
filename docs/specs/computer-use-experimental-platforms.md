# Computer Use Windows/Linux 实验平台支持

状态：已实现（2026-10-22）；上游实验声明依据见 `docs/plans/2026-10-21-mikiko-open-computer-use-design.md` 与上游 open-computer-use `docs/ARCHITECTURE.md`、`SECURITY.md`（"Linux and Windows runtimes remain experimental"）。
关联：`docs/cua/2026-08-27-computer-use-unsupported-environment-ui-spec.md`（本 spec 修订其中 Linux 本地一行）。

## 1. Feature Summary / Impact Brief

| Field | Value |
| --- | --- |
| Developer intent | 让 Windows/Linux 桌面获得 Computer Use 能力（基于上游 open-computer-use 的实验性 Go 运行时），并在系统设置-电脑控制中明确标识实验阶段 |
| Capability | desktop 打包资产链（交叉构建/staging/extraResources）、`GetCuaOsSupport`、设置页 电脑控制 |
| 平台矩阵 | 本地 macOS ≥14：supported（不变）；本地 Windows/Linux：**supported + experimental**；远端 SSH/WSL/Docker/Server 与 Web：不支持（不变） |
| Out of scope | 正式安装包打包（本轮只做交叉编译与资产 staging 验证）；Windows 代码签名；macOS 行为变化 |

## 2. 构建链（新增，独立于 Swift builder）

`scripts/build-mikiko-computer-use-cross.mjs`：

- 同一 pinned 上游（复用 `build-mikiko-computer-use.mjs` 的 `UPSTREAM`），仅取 `apps/OpenComputerUseWindows`、`apps/OpenComputerUseLinux` 源（含内嵌 `runtime.ps1`/`runtime.py`，`go:embed` 进二进制）。
- `--os win32|linux --arch x64|arm64 [--production] [--compile-only]`；`GOOS/GOARCH CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=<上游版本>"` 从 macOS 交叉编译。
- 产物：`.cache/mikiko-computer-use/cross/<variant>/<os>/<goarch>/mikiko-computer-use-<os>-<arch>[.exe]` + `provenance.json`（含 `experimental: true`、`signature: "unsigned experimental build"`、跨编译不执行探针）。
- staging（`mikiko-computer-use-assets.mjs` 参数化 `os`）：校验 experimental 契约 → `bundled-tools/<os>-<arch>/mikiko-computer-use/`（二进制 + provenance + esbuild 重打的 `production-server.mjs` + gateway-provenance）。win/linux finalize 仅做哈希校验并写 `signing-provenance.json`（unsigned experimental），不做 codesign/lipo。
- `bundle.mjs` 按 target os 分发（mac 原逻辑不变）；`electron-builder.config.js` 为 win32/linux 增加 `bundled-tools/<key>/mikiko-computer-use → computer-use` extraResources 与 afterPack finalize（与链路 A 的 `shouldPackageComputerUseHelper` 无关）。

## 3. 运行时与 UI

1. `CuaOsSupport` 的 `supported` 增加可选 `experimental: boolean`（`packages/shared/src/platform.ts`）。
2. `resolveMikikoComputerUseSupport`（desktop main）：`win32|linux` → `{ kind: "supported", backend: "mikiko-native", experimental: true }`（资源缺失仍 build-unavailable；版本地板仅 darwin 判定）。
3. `resolveMikikoComputerUseResources`：win/linux 布局 = 打包态 `resources/computer-use/mikiko-computer-use-<platform>-<arch>[.exe]` + `production-server.mjs`；dev 态走 `MIKIKO_COMPUTER_USE_BINARY/SERVER` env 或 cross 缓存；`appPath` 对无 .app 平台等于 binary 路径。
4. 设置页电脑控制（Windows/Linux 本地）：
   - 渲染实验警告卡（BETA 徽标 +「实验阶段，可能不稳定」+ 平台说明：Windows=UIA/PowerShell 桥；Linux=AT-SPI，需已登录桌面会话、Wayland 支持有限）；
   - 复用总开关/输入框入口开关；macOS 权限区（辅助功能/屏幕录制）仅 darwin 渲染；
   - 导航与内容标题在 Windows/Linux 显示 BETA 角标（`titleBadgeId` 条件化 + 导航项角标渲染，macOS 不显示）。
5. `computerUseAvailability`：`local-linux` 改 supported 并标记 experimental；`isComputerUseRemoteOrLinux` 不再把 local-linux 算入不可用（插件列表占位行随之为远端专属）。
6. macOS 行为逐字节不变（矩阵、权限流、BPM 不加角标）。

## 4. 事件顺序与边界

```text
bundle --os win/linux
  → build-mikiko-computer-use-cross（pinned 上游 → go build → provenance）
  → computer-use-open build（gateway，平台无关）
  → stageMikikoComputerUseResources(os)（校验+staging bundled-tools）
  → electron-builder extraResources(afterPack 哈希校验)      [本轮止步于此，不打包]

运行时 GetCuaOsSupport → resolveMikikoComputerUseSupport(platform, release, 资源可用)
  → win/linux: supported+experimental → 设置页实验分支（警告卡+开关，无 macOS 权限行）
```

## 5. 验收

- 交叉编译：从 macOS 产出 win32-x64/arm64、linux-x64/arm64 四个 Go 二进制 + provenance，`--compile-only` 与完整 staging 两种模式可用。
- 单测：`cuaOsSupport` 矩阵（win/linux supported+experimental、darwin 不变、资源缺失 build-unavailable）；`resolveMikikoComputerUseResources` win/linux 打包/dev 布局；`computerUseAvailability` linux supported+experimental；`settingsPageConfig` BETA 角标仅 win/linux；cross builder plan 参数校验。
- 全量：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、desktop/ui/shared 相关单测。
- 不做安装包（用户指令：先不打包）。
