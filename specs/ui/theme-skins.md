# 主题皮肤（Theme Skins）

状态：实现中（2026-10）。关联：`specs/desktop/session-drag-out-window.md`（会话窗口面板本地化）、`DESIGN.md`（token 语义）。

## 1. 产品规则

- 主题模式（system / mikiko-light / mikiko-dark）与主题皮肤是两个独立维度：
  - **主题模式**保持现状不动，决定基础 token 类（`.theme-mikiko-light/dark`）；
  - **主题皮肤**叠加在基础主题之上，由 light/dark 两套 token 覆盖 + 可选壁纸层组成。
  - 皮肤必须同时提供 light 与 dark 两套 token；当前模式为 system 时跟随系统解析结果。
- 设置 → 外观，新增「主题皮肤」设置项（界面设置卡片下方）：只展示当前皮肤名称与缩略预览，点击进入二级页面切换（交互模式与宠物管理二级页一致：summary | manage 视图状态机 + `SettingsBreadcrumbReporter` 面包屑返回）。
- 二级页面能力：
  - 网格展示内置皮肤 + 自定义/导入皮肤（卡片 = 新建会话页缩略预览 + 名称 + 徽标），可切换明/暗预览模式；
  - 使用（立即生效）、编辑、导出（.mikikotheme）、删除；
  - 导入 .mikikotheme 文件；新建空白自定义皮肤（基于当前或默认皮肤）。
- 保护规则：
  - 内置皮肤不可删除、不可原地修改；对内置皮肤编辑后保存时自动创建自定义副本（新 id、builtin=false），原内置数据不变；
  - 内置皮肤必须包含「默认」皮肤（默认 = 零覆盖，即产品原生外观）；
  - 导入的皮肤视同自定义皮肤，可直接编辑与删除。
- 编辑（微调）能力（`ThemeSkinEditView`）：
  - 名称；
  - 「一键配色」：已配置壁纸（图片或内置渐变）时，按壁纸像素自动生成明暗两套完整配色（见 §8）；
  - 每个模式的主题色（accent）、主按钮色（primary，前景色自动按亮度对比生成）、文本色（foreground）；
  - 壁纸：选择本地图 / 清除、取景（cover/contain）、模糊（0-24px）、压暗（浅色/深色模式各自 0-100%，浅色为白纱、深色为黑纱）；
  - 主预览为「新建会话页」的缩略 mock，支持明/暗两模式渲染预览。
- 桌面专属能力（与宠物一致）：非桌面环境（Web/远控）不展示入口、不应用皮肤。

## 2. 状态所有者与事件顺序

```text
┌────────────── renderer（每个窗口） ──────────────┐
│ ZCodeStore.themeSkin: ThemeSkinRuntimeState|null │  唯一 UI 事实源
│  ├─ localStorage "mikiko-theme-skin"（启动同步快照，防闪烁）│
│  ├─ setThemeSkin → applyThemeSkinDom() + broadcast│
│  └─ 广播/ storage 事件 → 其它窗口重放 applyThemeSkinDom │
│ applyThemeSkinDom：documentElement inline style   │
│  ├─ 覆盖 --color-*（按当前模式取 light/dark 集）   │
│  ├─ 壁纸激活时把窗口面 token color-mix 半透明化     │
│  └─ 写 --app-wallpaper-image/blur/dim/fit 变量    │
└──────────────────────────────────────────────────┘
┌────────────── desktop main（磁盘库） ─────────────┐
│ ~/.mikiko/v2/theme-skins/<id>/{theme.json, wallpaper.*} │
│ desktopThemeSkinService：list/save/delete/导出读/导入 │
│ themepack://local/asset?path=… 只放行库内图片      │
└──────────────────────────────────────────────────┘
```

事件顺序（应用一个皮肤）：

1. UI 调 `store.setThemeSkin(runtime)`；
2. 写 localStorage 快照 → `applyThemeSkinDom()`（先清旧变量再设新值，幂等）→ broadcast `themeSkin` 字段；
3. 其它窗口收到广播（store 窗口）或 storage 事件（hook 宿主窗口，由 `AppWallpaperLayer` 订阅）→ 重放 apply；
4. 主题模式切换（含 system 监听）→ `applyTheme` 后必须重放 `applyThemeSkinDom`（模式决定用 light 还是 dark token 集）。

内置皮肤不落盘：定义在 `@zcode/shared/theme-skins`（纯数据常量），renderer 直接可读；磁盘库只存自定义/导入皮肤。「当前应用」的快照存 token 全量（不依赖磁盘文件在），删除正在使用的皮肤时 UI 先回落默认再删目录。

## 3. .mikikotheme 文件格式

单文件 JSON（人可读、zod 校验、无 zip 依赖），壁纸以 dataURI 内嵌：

```jsonc
{
  "format": "mikiko-theme-skin",
  "formatVersion": 1,
  "name": "…", "description": "…", "author": "…", "version": "1.0.0",
  "light": { "--color-accent": "#…", … },   // 键 ⊆ token allowlist
  "dark":  { … },
  "wallpaper": {                              // 可选
    "kind": "image",                          // image | css
    "dataUrl": "data:image/webp;base64,…",    // kind=image 且来自导出时
    "css": "linear-gradient(…)",              // kind=css
    "fit": "cover" | "contain",
    "blurPx": 0, "dimPercentLight": 46, "dimPercentDark": 12
  }
}
```

导入校验（main 侧执行）：文件 ≤ 20MB；键 ⊆ allowlist；值匹配颜色语法（#hex / rgb(a) / hsl(a) / transparent）；壁纸 mime ∈ png/jpeg/webp 且解码后字节 ≤ 15MB；名称非空且 ≤ 60 字符。拒绝一切越界键（防止覆盖 success/destructive 等语义功能色）。

Token allowlist（每模式，~30 个）：`--color-{background,background-win-alt,header,panel,sidebar,card,popover,popover-header,menu,toast,tooltip,tooltip-tag,tag,tab,tab-active,input,accent,brand,primary,primary-foreground,secondary,foreground,foreground-subtle,foreground-subtlest,foreground-inverse,border,border-hover,hover,selected,surface,surface-hover,menu-hover}`。派生 token（`background-alt`、`terminal-bg/fg`、各 `*-border` 等）在 styles.css 里以 `var()` 引用这些主 token，皮肤覆盖后自动跟随。语义功能色（success/warning/destructive/diff/git/终端 ANSI/图表）不允许皮肤覆盖。

## 4. 壁纸层与透显

- `AppWallpaperLayer`（pointer-events-none）：图片层（blur 时向外扩 `blurPx` 防 edges bleed，父级 overflow-hidden）+ 模式感知压暗纱（dark=黑纱、light=白纱，alpha=dimPercent）。
- 挂载点：`DesktopWindowFrame` 内层 relative 容器首位 + `SessionWindowRoot` 根部；DOM 顺序在内容之前，天然垫底。
- 透显（两路叠加，缺一不可）：
  - 皮肤**已定义**的 token：apply 逻辑把窗口面 token（background/sidebar/header/panel/win-alt）以 `color-mix(in srgb, <值> 55%~65%, transparent)`、内容面 token（card/popover/menu/tooltip/input/tab…）以 85%~94% 包装（inline style）；
  - 皮肤**未定义**的 token：styles.css 的 `.has-app-wallpaper.theme-mikiko-light/dark` 块提供同款半透明基础值兜底（修复：皮肤只覆盖旋钮项时壁纸被全不透明面板盖住的问题）；
  - 无壁纸时不透明；popover/menu 保持较高不透明度保证可读；预览容器在皮肤有壁纸时同步挂 `has-app-wallpaper` 类保证所见即所得。
- 图片 URL：自定义皮肤经 `themepack://local/asset?path=<abs>`（特权协议，仅放行 theme-skins 根目录 + png/jpg/jpeg/webp）；编辑器选图未保存前用现有 `createLocalMediaPreviewUrl` 预览，保存时 main 从源路径复制进库目录。

## 5. 存储（desktop main 服务，仿宠物市场）

- 目录：`~/.mikiko/v2/theme-skins/<skinId>/theme.json`（与 .mikikotheme 同构，但壁纸为 `{"kind":"image","file":"wallpaper.webp",…}` 相对引用）+ `wallpaper.<ext>`。壁纸图片**总是复制一份入库**（编辑器选图 → staging 暂存 → 保存转正为库内 `wallpaper.<ext>`；导入 → dataURI 解码落库），运行时只引用库内副本，源文件移动/删除不影响主题；导出时再从库内副本内嵌 dataURI，导入导出自洽。
- 写入：mkdtemp 暂存 → rename 原子切换（同宠物 install）；skinId 形如 `user-<rand>`（导入/新建时生成，`^[\w.-]+$` 校验）。
- IPC（platform 通道，均为 IPlatformService 可选方法）：`themeSkinListInstalled` / `themeSkinImportFromFile`（含文件对话框+校验+安装）/ `themeSkinSaveCustom`（新建或原地更新，壁纸携带源路径复制）/ `themeSkinDelete` / `themeSkinReadExportFile`（读磁盘皮肤并内嵌 dataURI 组装 .mikikotheme JSON；内置皮肤由 renderer 从常量组装）/ `themeSkinSelectWallpaperImage`（图片过滤对话框）。
- 导出落盘复用 `platform.saveFile({data, suggestedName})`。

## 6. 内置皮肤（6 套，均含 light+dark）

| id                 | 名称        | 风格                               | 壁纸                  |
| ------------------ | ----------- | ---------------------------------- | --------------------- |
| `mikiko-default`   | Mikiko 默认 | 零覆盖（产品原生）                 | 无                    |
| `terracotta-paper` | 陶土纸面    | 暖石纸中性 + 陶土红点缀（暖色系）  | 无                    |
| `forest-study`     | 墨绿书房    | 骨白/墨绿黑 + 森林绿点缀           | CSS 渐变（绿调 mesh） |
| `cobalt-ink`       | 钴蓝墨水    | 冷纸灰/墨蓝黑 + 钴蓝主色（冷色系） | 无                    |
| `sakura-dusk`      | 暮樱        | 绯白/梅紫黑 + 玫瑰点缀             | CSS 渐变（粉紫 mesh） |
| `terminal-noir`    | 暗夜终端    | 近黑 + 终端绿点缀（dark-tech）     | 无                    |

配色纪律（design-taste-frontend）：不用纯黑纯白、饱和度克制、每套单一 accent、明暗两模式文本对比度保持可读。

## 8. 一键配色（自动取色）

- 算法：Google Material You 动态取色（`@material/material-color-utilities`，Android 12+ 壁纸主题同款）：
  1. 壁纸像素（图片经缩放 canvas；CSS 渐变经 canvas 填充取样）→ Celebi 量化 + Score 评分得到 source color；
  2. source 的 HCT 色相生成三支色调调色板：neutral（chroma 4）、neutralVariant（8）、primary（max(24, min(48, 源饱和度))，低饱和壁纸兜底保证按钮有色）；
  3. 按色调位映射到 33 token 明暗两套，色调位对齐 mikiko 基础主题的既有取值（如浅色 background=N98、深色 background=N8），保证自动结果观感原生、明暗可读（MD3 色调位自带对比度保证）。
- 数据面：图片壁纸经 `themeSkinReadWallpaperDataUrl` 通道在 main 侧读库内副本转 dataURL（themepack URL 直接进 canvas 会因跨域污染无法 getImageData）；CSS 渐变纯 renderer 采样。
- 一键配色**整体替换**当前明暗 token 集（它是完整方案，不是局部微调），替换后仍可继续用旋钮微调；不改动壁纸与压暗参数。
- 确定性：同壁纸同结果（算法无随机源）。

## 9. 验收场景

1. 外观页显示当前皮肤名 + 缩略预览；进入二级页可切换 6 套内置皮肤，切换立即生效（主窗口 + 会话窗口同步）。
2. 深浅主题切换（含 system 跟随）后皮肤仍正确应用对应模式 token。
3. 有壁纸皮肤：会话区/侧栏透显壁纸，popover/菜单保持可读；模糊/压暗滑条实时变化。
4. 编辑内置皮肤 → 保存自动生成副本，内置卡片不变；副本可再次编辑/删除。
5. 导出皮肤得到 .mikikotheme；删除后重新导入，皮肤（含壁纸）完整还原。
6. 恶意/损坏 .mikikotheme（越界 token、非图片 mime、超限体积）被拒绝并提示，不落盘。
7. 删除正在使用的皮肤 → 回落默认皮肤；localStorage 快照损坏 → 安全回落默认。
8. `pnpm typecheck` / `pnpm lint` 通过；shared/desktop 服务测试通过。
9. 一键配色：配置图片壁纸后点击，明暗预览立即呈现与壁纸同色系的完整配色；两模式文本对比度可读；纯色/低饱和壁纸也能产出有色按钮与中性表面。
