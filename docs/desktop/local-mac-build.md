# 本地 macOS 打包指南

本文描述如何在本地 macOS 上手动打包桌面端（Mikiko.app / DMG），命令与 CI workflow
（`.github/workflows/release-desktop.yml`）完全对应，可用于：

- 验证打包流程本身是否健康（无签名基线）。
- 本地验证签名链路（证书在登录 keychain 的常规方式）。
- 完整复刻 CI 的临时 keychain 签名环境，复现/排查 CI 上 codesign 挂起的问题。

> 写作基线：`custom_main` @ `40b7532d`（2026-10-19）。当天 CI 的 mac 打包全部失败，
> 根因是 GitHub runner 临时 keychain 上 codesign 挂起，详见文末「排查 codesign 挂起」。

## 0. 前置条件

| 依赖     | 要求                                                                  |
| -------- | --------------------------------------------------------------------- |
| 操作系统 | macOS（arm64 机器可直接打 arm64 和 x64 双架构包，CI 即是这么做的）    |
| Xcode CLT| `xcode-select --install`（提供 `codesign` / `security` / `xcrun`）    |
| Node     | 24.14.0（以 `mise.toml` 为准）                                        |
| pnpm     | 10.33.2（以 `mise.toml` / `package.json` 的 packageManager 为准）     |
| 磁盘     | 打包含 Electron 下载与 asar 解包重打包，建议预留 ≥ 10 GB             |

工具链就绪（仓库使用 mise 管理）：

```bash
mise install          # 安装 mise.toml 里钉住的 node/pnpm
mise exec -- node -v  # 应输出 v24.14.0
```

## 1. 安装依赖

```bash
cd <仓库根目录>
pnpm install --frozen-lockfile
```

CI 对齐的环境变量（本地建议同样设置，行为与 CI 完全一致；不设也能打，但产物环境不同）：

```bash
export MIKIKO_ENV=production          # 生产 flavor（不带测试产物名后缀）
export MIKIKO_SKIP_REMOTE_ASSETS=1    # 跳过远程资源拉取，打包态不依赖
export HUSKY=0                        # 跳过 git hooks
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # 国内加速 Electron 下载
```

## 2. 打包命令

入口脚本（参数说明见 `node packages/desktop/scripts/bundle.mjs --help`）：

```bash
# 本机架构（arm64）
pnpm bundle:desktop

# 指定架构
pnpm bundle:desktop -- --os mac --arch arm64
pnpm bundle:desktop -- --os mac --arch x64

# 辅助参数
#   --skip-prepare   跳过 prepare:runtime-assets
#   --skip-build     跳过 pnpm build（调试打包配置时可省几分钟）
#   --dry-run        只打印最终 electron-builder 命令，不执行
```

产物位置（`packages/desktop/dist/`）：

| 内容                 | 路径                                                |
| -------------------- | --------------------------------------------------- |
| arm64 应用目录       | `packages/desktop/dist/mac-arm64/Mikiko.app`        |
| x64 应用目录         | `packages/desktop/dist/mac/Mikiko.app`              |
| DMG 安装包           | `packages/desktop/dist/Mikiko-<version>-mac-<arch>.dmg` |

无签名模式（不设置第 3 节的任何签名变量）下，CI 的健康基线是
**bundle 全程约 6–12 分钟**（electron-builder 下载 Electron 约 10s、
vite build 约 40s、asar 注入/清理约 2 分钟、封 DMG 其余时间）。
本地超过 20 分钟无输出基本可判定异常。

## 3. 路线 B：带签名打包（证书已在登录 keychain，本地常规方式）

适用于开发者 Mac 上已经装好「Developer ID Application」证书（Keychain Access 里可见）。
这是本地签名打包的首选方式，不碰系统默认 keychain，风险最低。

### 3.1 确认签名身份

```bash
security find-identity -v -p codesigning
```

输出形如（重点看 Developer ID Application 那行）：

```
1) XXXXXXXX "Developer ID Application: COMPANY NAME (TEAMID123)" (hash)
```

注意：如果列表里出现**多条同名 Developer ID Application 身份**，codesign 可能交互式
等待选择，在无头/管道环境下表现为永久挂起——这是排查 CI 挂起时要重点检查的点。

### 3.2 打开签名开关并打包

```bash
# 完整身份串（含 "Developer ID Application: " 前缀，与 CI secret MAC_SIGNING_IDENTITY 同格式）
export APPLE_SIGNING_IDENTITY="Developer ID Application: COMPANY NAME (TEAMID123)"
export MIKIKO_ENABLE_MAC_SIGN=1

pnpm bundle:desktop -- --os mac --arch arm64
```

配置侧行为（`packages/desktop/electron-builder.config.js`）：

- `identity` 自动启用，`hardenedRuntime: true`，entitlements 使用
  `build/entitlements.mac.plist` / `build/entitlements.mac.inherit.plist`。
- `notarize: false`——公证被显式拆出打包阶段，bundle 只签不发。
- `signIgnore` 跳过 `Contents/Resources/{glm,tools,cua-helper}` 目录：
  electron-builder 不深扫这些目录（全量深扫在本包 node_modules 树上实测 60min+）。
  **这意味着 glm/tools 下的嵌套 Mach-O（koffi.node、rg、bfs、ugrep 等）在 bundle
  阶段不会被签名**，需要后续预签名（见第 5 节的已知问题说明）。
- `macos-window-bounds/` 不在 signIgnore 里，由 electron-builder 自行签名。

### 3.3 验证产物

```bash
cd packages/desktop/dist

# 主 app 签名校验（不含嵌套深扫）
codesign --verify --verbose mac-arm64/Mikiko.app

# 查看签名详情（TeamIdentifier 应为 Developer ID 的 team）
codesign -dv --verbose=4 mac-arm64/Mikiko.app 2>&1 | head -20

# Gatekeeper 评估（已签名但未公证时输出 "Developer ID ID: ... 但未公证"，属预期）
spctl -a -vv -t exec mac-arm64/Mikiko.app
```

注意：`codesign --verify --deep --strict` 在当前配置下**会失败**——glm/tools 里的
嵌套二进制被 signIgnore 跳过、处于未签名状态，`--deep` 会扫到它们。这是已知分层
设计，不代表打包坏了。检查嵌套二进制实际签名状态：

```bash
cd packages/desktop/dist/mac-arm64/Mikiko.app/Contents/Resources
for bin in glm/packages/zcode-cua-plugin/node_modules/koffi/build/koffi/*/koffi.node \
           tools/bfs/bfs tools/ripgrep/rg tools/ugrep/ugrep \
           macos-window-bounds/zcode-window-bounds; do
  [ -f "$bin" ] || continue
  printf '%-90s ' "$bin"
  codesign -dv "$bin" 2>&1 | grep -E "Authority=|adhoc|code object is not signed" | head -1 || echo "未签名"
done
```

## 4. 路线 C：完整复刻 CI 签名链路（临时 keychain）

目的：在本机复现 CI 的签名环境（临时 keychain + 分区列表），验证/复现 CI 上的
codesign 挂起。以下命令逐行镜像 workflow 的 `Prepare macOS signing identity` 步骤。

需要先拿到 p12 证书文件（CI 对应 secret `MAC_SIGNING_P12_BASE64` 的原始文件）及其
密码。

```bash
cd <仓库根目录>
KEYCHAIN=build-mac-sign.keychain-db

# --- 清理上次残留（幂等） ---
security delete-keychain "$KEYCHAIN" 2>/dev/null || true

# --- 镜像 CI：建临时 keychain 并设为系统默认 ---
security create-keychain -p "" "$KEYCHAIN"
security default-keychain -s "$KEYCHAIN"
security unlock-keychain -p "" "$KEYCHAIN"

# --- 导入证书（-T 允许 codesign 免密访问） ---
security import /path/to/mac-sign.p12 -k "$KEYCHAIN" -P "<P12密码>" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -k "" "$KEYCHAIN"

# --- 确认身份唯一 ---
security find-identity -v -p codesigning "$KEYCHAIN"

# --- 打包（与 CI 完全相同的环境） ---
export APPLE_SIGNING_IDENTITY="<完整身份串>"
export MIKIKO_ENABLE_MAC_SIGN=1
export MIKIKO_ENV=production
export MIKIKO_SKIP_REMOTE_ASSETS=1
export HUSKY=0
pnpm bundle:desktop -- --os mac --arch arm64
```

⚠️ **务必还原**（`default-keychain -s` 改变了系统默认 keychain，不还原会影响日常
签名、iCloud 钥匙串等）：

```bash
security default-keychain -s ~/Library/Keychains/login.keychain-db
security delete-keychain build-mac-sign.keychain-db
```

打包成功后，先手动冒烟测试一次「CI 同款」codesign 再跑大包，可以把复现成本从
20 分钟缩到几秒：

```bash
# 单文件签名冒烟（对任一嵌套二进制）——CI 挂起时这一步在 runner 上永不返回
codesign --sign "$APPLE_SIGNING_IDENTITY" --force --options runtime \
  packages/desktop/dist/mac-arm64/Mikiko.app/Contents/Resources/tools/ripgrep/rg \
  --verbose=4 && echo SIGNED_OK
```

## 5. 公证（可选，需要 Apple 账号凭据）

打包产物要可分发，需要 签名 → 公证 → staple。仓库脚本：`scripts/notarize-macos.sh`。

### 5.1 准备公证凭据（三选一，脚本按此顺序探测）

本地推荐用 keychain profile（一次存储，长期使用）：

```bash
xcrun notarytool store-credentials mikiko-notary \
  --apple-id "<AppleID>" \
  --team-id "<TEAMID>" \
  --password "<应用专用密码>"    # appleid.apple.com 生成，不是账号密码
```

### 5.2 执行公证

```bash
cd <仓库根目录>
export APPLE_KEYCHAIN_PROFILE=mikiko-notary
export APPLE_SIGNING_IDENTITY="<完整身份串>"
export SIGN_RUNTIME_DIR="$PWD/packages/desktop/dist"
sh scripts/notarize-macos.sh packages/desktop/dist/Mikiko-*-mac-arm64.dmg
```

脚本流程：DMG 签名校验/补签 → `notarytool submit --wait` → `stapler staple` →
`codesign`/`stapler`/`spctl` 三重验收，并对同目录 `.app` 做 deep 校验。

### 5.3 ⚠️ 当前 HEAD 的两个已知问题（本地跑公证前必读）

以下是 `40b7532d` 引入的现状，本地复现时会遇到，属于链路设计问题而非操作错误：

1. **嵌套二进制预签名时机无效**：预签名被移到了公证脚本里（bundle 之后）执行，
   但 DMG 在 bundle 阶段就已经从 `.app` 封装完成——公证脚本改签 `dist/` 下的
   `.app` 目录**不会改变 DMG 内容**。DMG 内 glm/tools 的 Mach-O 仍是未签名，
   提交公证预期会被 Apple 判 Invalid（原始拒绝原因可在公证日志里看到）。
2. **x64 产物目录不匹配**：脚本里 `find -name "mac-arm64" -o -name "mac-x64"`
   只匹配 `mac-arm64`；x64 的产物目录是 `dist/mac`，预签名对 x64 完全不生效。

在链路修复前，本地验证建议以「路线 B/C 打出签名 .app」为终点；公证链路等
预签名时机修正（需在 DMG 封装前完成嵌套二进制签名）后再联调。

## 6. 排查 codesign 挂起（CI 问题的本地复现手册）

CI 症状回顾（2026-10-19，8 次 mac 尝试全部失败）：

- afterPack 内 `spawnSync codesign`：30s/120s 超时后 ETIMEDOUT（5 次）。
- electron-builder 内部签名：无超时机制，静默挂起 79–83 分钟直到 job 90 分钟
  timeout 被杀，teardown 日志显示孤儿进程正是 `codesign`（3 次）。

### 6.1 复现路径

用第 4 节路线 C 建好临时 keychain 后，从**干净 shell** 直接跑第 4 节末尾的
`codesign --verbose=4` 单文件冒烟命令。本地能复现挂起 → 是 keychain 配方问题；
本地秒过 → 是 GitHub runner 环境问题（如 runner 镜像更新）。

### 6.2 挂起时收集证据（另开一个终端）

```bash
# 找到挂起的 codesign 进程
ps aux | grep -v grep | grep codesign

# 采样该进程调用栈（macOS 自带，无需 sudo；10 秒采样）
sample <pid> 10 -file /tmp/codesign-sample.txt
open /tmp/codesign-sample.txt     # 看卡在哪个系统调用/框架

# 检查 keychain 搜索列表——临时 keychain 是否在列、login 是否也在列
security list-keychains -d user

# 检查身份是否重复（同名多条会导致 codesign 等待交互选择 → 无头环境永久挂起）
security find-identity -v -p codesigning
security find-identity -v -p codesigning build-mac-sign.keychain-db

# 检查分区列表是否覆盖 codesign（缺 apple-tool: 分区会触发 GUI 授权弹窗 → 无头挂起）
security show-keychain-info build-mac-sign.keychain-db
```

### 6.3 已知可疑点（按优先级）

1. **runner 镜像变更**：10-15 之前签名链路不存在，所有失败集中在 10-19；若本地
   一切正常，优先对比 `macos-latest` 镜像版本（run 页面 Environment/runner 面板）。
2. **linker-signed adhoc 二进制**：arm64 上唯一必挂的文件是
   `macos-window-bounds/zcode-window-bounds`（linker 签名的通用二进制），对这类
   文件 `codesign --force` 重签前需先 `codesign --remove-signature`（`dfe823b0`
   尝试过但当天被 revert，未单独验证过该假设）。
3. **分区列表配方**：`set-key-partition-list -S apple-tool:,apple: -k ""` 是标准
   配方；若 runner 上 unlock 状态或 session keychain 有差异，codesign 取私钥时会
   等待授权。可用 `--verbose=4` 观察挂在「signing with identity」之后的哪一步。

### 6.4 判定标准

| 本地现象                              | 结论                                      |
| ------------------------------------- | ----------------------------------------- |
| 路线 B（登录 keychain）正常、路线 C 挂 | 临时 keychain 配方/环境问题               |
| 路线 B 也挂                           | 本机 keychain 有重复身份/授权弹窗问题     |
| 两者都正常                            | GitHub runner 环境问题（对比镜像版本）    |
| 仅个别二进制挂（zcode-window-bounds） | linker-signed 重签问题，先 remove 再签    |

## 7. 常见问题

- **Electron 下载慢/失败**：确认 `ELECTRON_MIRROR` 已设置（见第 1 节）。
- **bundle 脚本自带重试与心跳**：日志里 `[bundle][heartbeat] elapsed_ms=... idle_ms=...`
  表示 electron-builder 仍在运行及静默时长；`idle_ms` 超过几分钟即接近挂死。
- **x64 与 arm64 产物目录不同**：`dist/mac/`（x64）vs `dist/mac-arm64/`（arm64），
  检查产物时别看错目录。
- **只想验证打包配置**：`pnpm bundle:desktop -- --os mac --arch arm64 --dry-run`
  只打印最终 electron-builder 命令，不实际执行。
- **`--deep --strict` 失败**：见 3.3，signIgnore 目录未签名属预期，不是回归。

## 8. 本地步骤与 CI 的对应关系

| 本地（本文）               | CI（release-desktop.yml）                          |
| -------------------------- | -------------------------------------------------- |
| 第 1 节 pnpm install       | `Install dependencies`                             |
| 第 4 节临时 keychain 三步  | `Prepare macOS signing identity`                   |
| 第 2/3 节 bundle 命令      | `Bundle desktop installers`（`pnpm bundle:desktop -- --os mac --arch <arch>`） |
| 第 5 节 notarize-macos.sh  | `Notarize macOS DMG`（含 `SIGN_RUNTIME_DIR` 导出） |
| 第 4 节末尾还原命令        | `Cleanup macOS signing keychain`                   |
