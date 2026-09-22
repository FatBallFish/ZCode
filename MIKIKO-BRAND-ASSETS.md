# Mikiko 品牌资产规格清单（v2.0：资产已产出）

> 版本：v2.0（2026-09-22）· 配套 [MIKIKO-REBRAND-PLAN.md](MIKIKO-REBRAND-PLAN.md) §2.3 / D9
> v2.0 变更：Qwen 生图（App 图标、DMG 背景）+ 手工 SVG（图形标/字标/组合）已全部产出并通过验收，
> 暂存于 [brand/mikiko/](brand/mikiko/README.md)（含落位映射与复现参数）；待办仅剩可选项。

---

## 1. 产出状态总表

### A 类：代码内 SVG（✅ 已产出，S1 时替换进组件）

| #   | 位置                                                      | 产出文件                                               | 状态                                                |
| --- | --------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| A1  | `packages/ui/src/components/ui/ZCodeAboutLogo.tsx` 图形标 | [brand/mikiko/mark.svg](brand/mikiko/mark.svg)         | ✅ 等宽直线 M、方头端点、currentColor 双主题        |
| A2  | 同上 wordmark（原 "ZCODE" 5 path）                        | [brand/mikiko/wordmark.svg](brand/mikiko/wordmark.svg) | ✅ **path 化 MIKIKO**（纯 stroke path，无字体依赖） |
| A3  | `packages/desktop/src/main/aboutWindow.ts` 内联 SVG       | 同 A1（写死配色版按 mark.svg 手工落地）                | ✅ 源就绪                                           |
| A4  | `packages/web/index.html` loading 壳内联 SVG              | 同 A1                                                  | ✅ 源就绪                                           |
| A5  | README 头部组合                                           | [brand/mikiko/lockup.svg](brand/mikiko/lockup.svg)     | ✅ 图形标+字标横排                                  |

**图形标最终源码**（组件替换用，`--mikiko-mark-ink` 控制墨色，默认白）：

```svg
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-label="Mikiko">
  <rect x="4" y="4" width="56" height="56" rx="13" fill="currentColor"/>
  <path d="M18 44V20l14 15 14-15v24" fill="none"
        stroke="var(--mikiko-mark-ink, #ffffff)" stroke-width="6"
        stroke-linecap="square" stroke-linejoin="miter"/>
</svg>
```

**字标最终源码**（cap 高 28 / stroke 5 / 方头，六字母等宽直线+正圆构成）：

```svg
<svg viewBox="-3 -3 128 34" xmlns="http://www.w3.org/2000/svg" aria-label="MIKIKO">
  <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="square">
    <path d="M0 28V0l11 12 11-12v28"/>
    <path d="M29 0v28"/>
    <path d="M36 0v28M55 0 36 14l19 14"/>
    <path d="M62 0v28"/>
    <path d="M69 0v28M88 0 69 14l19 14"/>
    <circle cx="107" cy="14" r="9.5"/>
  </g>
</svg>
```

### B 类：二进制图标（✅ 已产出，暂存 brand/mikiko/）

| #       | 产出                                             | 规格                             | 目标落位                                        |
| ------- | ------------------------------------------------ | -------------------------------- | ----------------------------------------------- |
| B1      | `png/{16..512}x{16..512}.png`                    | 7 档 PNG                         | `public/logo/icons/`、README                    |
| B2/B3   | `icon.icns` / `icon.ico`                         | 16–1024 含 @2x / 256–16          | `public/logo/icons/`、`packages/desktop/build/` |
| B4      | `master-icon-1024.png`                           | 圆角透明母版（rx≈22.5%）         | 派生源；`icon_windows.png` 由 1024 母版直拷     |
| B6      | `icon.icns`/`icon.ico` 复制为 `icon_installer.*` | 同上                             | `packages/desktop/build/`                       |
| B8      | `png/*` 重命名                                   | 与 `build/icons/` 现有文件名一致 | Linux hicolor（`Icon=mikiko`）                  |
| B9      | `dmg_background.png`(+`@2x`)                     | 540×380 / 1080×760               | `packages/desktop/build/`                       |
| B10/B11 | `favicon.ico` / `favicon-ico-base64.txt`         | 32/16                            | `packages/web/public/`、`index.html` 内嵌       |

产出方式：**Qwen 生图**（`qwen-image-3.0-pro`；图标 seed 11、DMG 背景 seed 21；三个方向候选经视觉评审选型，母图通过中心裁切 100% 检查 + 64/32px 缩小测试）→ **macOS 原生流水线**派生（qlmanage SVG-clip 圆角光栅化 + sips 阶梯 + iconutil icns + Node 手写 ICO 打包器，零第三方依赖）。复现脚本与参数见 [brand/mikiko/README.md](brand/mikiko/README.md)。

### C 类：品牌色板（⏸ 沿用现值，可选项）

| #     | 位置                                    | 现值                                                                      | 状态                                                            |
| ----- | --------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C1/C2 | `styles.css` `.theme-mikiko-light/dark` | 黑白极简（背景 #f8f8f8/#161616、brand #000/#fff、accent #ebf4ff/#001d3d） | 与已产出资产的黑白语言一致，本期沿用；如需品牌色仅改 CSS 变量值 |

### 保留不动（第三方品牌）

- `packages/ui/src/assets/provider-icons/logo-zai*.svg` 等 Z.ai/BigModel 供应商图标。
- `WindowsTopLeftLogo.tsx` 对 `logo-zai.svg` 的产品 logo 挪用在 S1 解除（换 A1 图形标）。

---

## 2. 验收记录（2026-09-22，agent 执行）

- ✅ **一致性**：App 图标、SVG 图形标、字标、DMG 水印同用「黑底 + 等宽直线方头 M」语言；图标 M 与 SVG M 笔画宽度比一致（约 25% cap height）、端点同为方头。
- ✅ **小尺寸**：32px 下 M 清晰可辨（favicon 可用）；64px 完整。
- ✅ **母版**：1024 圆角透明外角无伪影、无双圆角叠影；icns/ico/PNG 各档 alpha 正确（sips 校验）。
- ✅ **DMG 背景**：黑底 + 左下淡 M 水印，右上留白，540×380 与 @2x 齐备。
- ✅ **字标**：纯 path（stroke 构成），无字体环境依赖，替代原 ZCODE 5-path wordmark。

## 3. 剩余待办（全部可选）

| #   | 事项                   | 说明                                                                                       |
| --- | ---------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 品牌色板精调           | 如需超出黑白的品牌色，仅改 `styles.css` 变量值 + 重生成 DMG 背景                           |
| 2   | Mikiko 官网/下载页     | 后期（D8 域名确定后）                                                                      |
| 3   | Sub2API 账号体系品牌位 | 随功能设计（方案 §7）                                                                      |
| 4   | 正式设计稿替换         | 如后续有设计师出稿：换 `raw/` 母图后重跑 `tools/build.mjs`、换 SVG path 即可，派生链全自动 |

---

## 4. 流水线参考（换母图后重跑）

```bash
# 1) 生成新候选（复现参数见 brand/mikiko/README.md）
cd brand/mikiko/tools && DASHSCOPE_API_KEY=sk-*** node gen.mjs mark-geometric
# 2) 派生全套（qlmanage 圆角光栅化 → sips 阶梯 → iconutil icns → Node ICO 打包 → DMG 缩放）
node build.mjs
```

> 依赖：macOS 自带 `qlmanage`/`sips`/`iconutil`；ImageMagick **不需要**（ICO 由脚本内打包器生成）。
