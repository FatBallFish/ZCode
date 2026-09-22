# DMG 安装器资产与下载外链

## 目标

- 架构不匹配弹窗（macOS Rosetta / Windows on ARM 转译运行时触发）的「前往下载」统一指向 GitHub Releases。
- DMG 安装背景为浅色底，保证黑色应用图标与 Applications 文件夹可见。
- 未签名打包模式下，DMG 内附带「安装必读.txt」说明文件，引导用户在终端手动执行 `xattr -rc /Applications/Mikiko.app` 清除隔离标记。

## 状态所有者

| 职责                    | 唯一所有者                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面对外发布页 URL      | `packages/desktop/src/main/desktopExternalLinks.ts` 的 `DESKTOP_RELEASES_DOWNLOAD_URL`（架构弹窗与 changelog 复用，不得再手写第二份）                                       |
| DMG 背景图派生          | `brand/mikiko/tools/build-dmg-background.mjs` → `packages/desktop/build/dmg_background{,@2x}.png`（派生产物，禁止手改）                                                     |
| 未签名 DMG 安装说明注入 | `packages/desktop/scripts/inject-unsigned-dmg-helper.mjs`（hdiutil shadow 方式注入 `build/dmg-install-readme.txt` 为卷内「安装必读.txt」，唯一写入路径）                    |
| 「未签名模式」判定      | 与 `packages/desktop/electron-builder.config.js` 的 `shouldEnableMacSigning` 同口径：`ZCODE_ENABLE_MAC_SIGN=1` 且存在 `APPLE_SIGNING_IDENTITY`/`CSC_NAME`；否则为未签名模式 |

## 产品规则

1. 架构不匹配弹窗的下载按钮打开 `https://github.com/FatBallFish/ZCode/releases`；macOS 与 Windows 共用同一实现（Linux 无转译检测路径，不涉及）。
2. DMG 背景固定尺寸 540×380（@2x 1080×760），白色为主体的极浅渐变；不因深色图标回退深色背景。
3. 未签名模式构建的 DMG 根目录包含 `安装必读.txt`（源自 `build/dmg-install-readme.txt`）：引导先把应用拖入 Applications，再在终端执行 `xattr -rc /Applications/Mikiko.app`（权限不足时加 `sudo`）清除 `com.apple.quarantine` 后启动。不使用 `.command` 等可执行文件——从未签名卷上执行会被 Gatekeeper 与卷路径问题拦截；已签名包不得注入。
4. 注入后 `.dmg.blockmap` 失效并删除——自动更新已被 `ZCODE_UPDATES_ENABLED` 屏蔽，blockmap 无消费方；恢复更新能力时需重新评估差分更新与注入脚本的兼容性。

## 失败语义

- 注入器找不到 DMG、挂载/卸载失败或注入后复验缺失/内容不一致的说明文件时，bundle 阶段直接失败，不产出「无说明的未签名 DMG」。
- 背景生成脚本产出的 PNG 尺寸或格式不符合预期时立即失败。

## 验收场景

1. M 系列 Mac 安装 x64 包启动：弹「架构不匹配」，点「前往下载」打开 GitHub Releases 页。
2. 未签名模式构建的 DMG 挂载后可见「安装必读.txt」，内容含完整安装步骤与终端清除隔离标记命令（中英双语）。
3. DMG 打开后为浅色背景，应用图标与 Applications 快捷方式清晰可见。
4. `ZCODE_ENABLE_MAC_SIGN=1` 且配置了签名身份的构建产物不包含该脚本。
