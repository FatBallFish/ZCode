# Mikiko 品牌资产包（已产出）

> 产出日期：2026-09-22 · 设计与验收：ZCode agent · 规格：见 [MIKIKO-BRAND-ASSETS.md](../../MIKIKO-BRAND-ASSETS.md)

## 设计语言

黑白极简（继承产品主题 mikiko-light/dark 的品牌色）：**等宽直线笔画、方头端点、完全对称的 M**。
App 图标（Qwen 生成）与代码内 SVG 图形标/字标（手工 path 构成）共用同一语言。

## 文件清单与落位映射

| 文件                                        | 规格                                                     | 目标落位（S1 执行时替换）                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `new-icon/master-1024.png`                  | 1024×1024 RGB 原图（棋盘格已烘焙）                       | 仅作为主体提取输入，不直接发布                                                                                                      |
| `master-icon-1024.png`                      | 1024×1024 便携透明母版，主体 896px                       | Windows、Linux、Web 派生源                                                                                                          |
| `master-icon-macos-1024.png`                | 1024×1024 macOS 透明母版，主体 824px                     | ICNS 与运行时 Dock 图标派生源                                                                                                       |
| `icon.icns`                                 | macOS 图标集（16–1024 含 @2x）                           | `public/logo/icons/icon.icns`、`packages/desktop/build/icon.icns`                                                                   |
| `icon.ico`                                  | Windows ico（256/128/64/48/32/16）                       | `public/logo/icons/icon.ico`、`packages/desktop/build/icon.ico`                                                                     |
| `favicon.ico`                               | 32/16 双尺寸                                             | `packages/web/public/favicon.ico`                                                                                                   |
| `favicon-ico-base64.txt`                    | favicon 的 base64                                        | `packages/web/index.html` 内嵌位                                                                                                    |
| `png/{16,24,32,48,64,128,256,512,1024}.png` | 9 档便携 PNG                                             | `public/logo/icons/*.png`、`packages/desktop/build/icons/`、Linux hicolor；`icon_windows.png` 与 `icon_512@2x.png` 直接使用便携母版 |
| `dmg_background.png` / `@2x`                | 540×380 / 1080×760                                       | `packages/desktop/build/dmg_background(@2x).png`                                                                                    |
| `icon_installer.*`                          | ——                                                       | 由 `icon.icns/ico` 复制为安装器专用名                                                                                               |
| `mark.svg`                                  | 图形标（64 viewBox，currentColor + `--mikiko-mark-ink`） | `ZCodeAboutLogo` 组件 / About 窗口 / Web loading 壳的内联 SVG                                                                       |
| `wordmark.svg`                              | MIKIKO path 化字标（纯 stroke path，无字体依赖）         | `ZCodeWordmarkLogo` 组件                                                                                                            |
| `lockup.svg`                                | 图形标+字标横排组合                                      | README 头部等                                                                                                                       |
| `raw/*.png`                                 | Qwen 生成原图（含未选中候选与验收裁切）                  | 归档，不落位                                                                                                                        |
| `tools/gen.mjs`                             | Qwen 生图脚本（密钥仅从 `DASHSCOPE_API_KEY` env 读取）   | 复现新候选                                                                                                                          |
| `tools/build-new-icon.mjs`                  | 主体裁切、双平台母版、全部格式与目标目录同步的唯一流水线 | 换母图后重跑                                                                                                                        |

## Qwen 生成参数（可复现）

- 模型：`qwen-image-3.0-pro`（DashScope 同步端点）
- 主图标 `mark-geometric`：seed 11，size 1024\*1024，watermark false，negative 屏蔽文字/圆角笔画/立体感等（完整 prompt 见 `tools/gen.mjs`）
- DMG 背景 `dmg-bg`：seed 21，size 1080\*760（2 倍生成后 sips 缩至 540×380）
- 评审过程：3 个方向（flat/round/geometric）各生成后由 agent 视觉评审，`mark-geometric-1` 经中心裁切 100% 检查与 64/32px 缩小清晰度测试后选定为母图

## 已知取舍

- App 图标内的 M（AI 位图）与 SVG 图形标的 M（矢量构成）为**同语言而非像素级相同**：笔画宽度比分别约 25% / 25%（图形标 6/24），端点同为方头；在图标与应用内 Glyph 两个尺度下观感一致。
- 原始 RGB 图的棋盘格与投影不会直接进入产物。流水线按固定主体边界重新生成 alpha；macOS 使用 824px 安全区，Windows/Linux/Web 使用 896px 安全区。
- DMG 背景与图标为同色系黑底，安装窗口浅色系统边框下对比正常。
