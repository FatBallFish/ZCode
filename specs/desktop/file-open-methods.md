# 会话文件「打开方式」扩展：默认应用 + 格式感知应用列表 + 修饰键点击

> 2026-10-02 定稿：会话里产出的 .docx/.xlsx/.pptx/.pdf/.mp3 等文件此前只能进内置预览或固定的编辑器白名单；本次扩展「打开」菜单与文件链接点击链路。

## 语义

「打开」入口（预览卡片 / 工具文件行的 `OpenSplitButton` 下拉框、markdown 文件链接 `MessageFileLink` 右键菜单）的菜单项构成，按序：

1. **用默认应用打开**（仅桌面本地文件）：调用既有 `IPlatformService.openExternalFile(path)` → main `shell.openPath`。系统无默认处理器时该项仍展示，执行失败 toast `chat.previewCards.openExternalFailed`。
2. **格式应用**：按文件扩展名从格式规则表中解析出的有序应用 id 列表（如 .xlsx → WPS/Microsoft Excel/Numbers；.go → GoLand/VS Code/…），过滤为「实际已安装」（复用 editors.ts 的 existsSync + icns 图标链路）。
3. **通用编辑器**：现有 `getInstalledEditors()` 白名单（VS Code/Terminal/Warp/Finder…），与第 2 项按 id 去重后追加。
4. 复制绝对路径 / 复制相对路径（不变）。

格式未命中规则表时第 2 项为空，菜单与现状完全一致；格式应用与编辑器均为空时展示 `chat.previewCards.noOpenApps` 占位。

## 状态所有者与数据流

- **应用检测的唯一所有者是 desktop main**（`editors.ts` 既有缓存 + 新增 `fileOpenApps.ts` 的按 id 缓存）；renderer 不做安装检测，只发 IPC 查询并持有组件局部 state（沿用 `loadEditors` 懒加载模式，菜单打开时触发）。
- **格式规则表是纯配置**（`fileOpenAppConfig.ts`，无 IO/electron 依赖，可单测）；main 侧解析 = 规则表（id 顺序）+ 安装检测（存在性过滤），UI 侧只做「格式应用 + 编辑器」合并去重。
- 远端 workspace（SSH/WSL/远程 identity）：格式应用与「默认应用打开」均隐藏（本地应用无法接收远端路径）；通用编辑器维持既有 `resolveWorkspaceEditorSelection` 行为。

```text
UI 菜单打开 → loadEditors + loadFileApps（并行、各自只发一次）
           → main: 规则表按扩展名解析 id 序列 → 逐 id：def 查找(格式应用defs ∪ 平台编辑器defs)
                    → resolveEditorDefAppPath(existsSync, 缓存) → getAppIconDataUrl(缓存)
           → UI: mergeFileOpenApps(格式应用, 编辑器) 去重保序 → 渲染

修饰键+点击（MessageFileLinkButton / OpenSplitButton 主按钮）：
  event.metaKey||ctrlKey（mac=Cmd+左键，Win/Linux=Ctrl+左键，与 MessageExternalLink 现行判定一致）
    → platform.openExternalFile(path)
        ├─ success → 结束（系统默认应用已接管）
        └─ 无能力(Web) / 失败 / 远端 → 走原有点击链路（内置预览）
                                    └─ 预览不支持 → PreviewPane 既有「二进制/不支持」占位（即侧栏提示）
```

## 接口变更

- `PlatformChannels.GetInstalledAppsForFile = "zcode:get-installed-apps-for-file"`（Renderer→Main，request: `string` 路径，response: `EditorInfo[]`）。
- `IPlatformService.getInstalledAppsForFile(path: string): Promise<EditorInfo[]>`（必选；Web 端 stub 返回 `[]`）。
- `openInEditor(editorId, …)` 的 id 查找范围从「平台编辑器 defs」扩展为「平台编辑器 defs ∪ 格式应用 defs」；格式应用无 CLI，走既有 `open -a <appPath> <path>`（mac）/ `execFile(appPath, [path])`（win）分支。
- 规则表 appIds 可引用既有编辑器 id（如 `vscode`/`goland`）；id 解析不到 def 时静默跳过（规则表与 defs 漂移的防御）。

## 失败语义

- IPC 失败 / 检测异常：格式应用列表为空，菜单回落现状；`logger.warn` 记录，不打断编辑器列表加载。
- `openExternalFile` 失败：下拉菜单项 → toast；修饰键点击 → 静默回落内置预览（`logger.debug`）。
- Linux：格式应用与编辑器检测均返回空（与现状一致），仅保留默认应用打开（`shell.openPath` 可用）。

## 配置表（大类 → 应用，维护于 fileOpenAppConfig.ts）

- 文档（doc/docx/rtf/odt）：WPS、Word、Pages；表格（xls/xlsx/xlsm/csv/ods）：WPS、Excel、Numbers；演示（ppt/pptx）：WPS、PowerPoint、Keynote；PDF：WPS、Acrobat。
- 音频（mp3/wav/flac/ogg/m4a/opus/weba/aac/wma/aiff）：VLC、IINA、Music、QuickTime、Windows Media Player；视频（mp4/mov/webm/m4v/mkv/avi/wmv/flv）：VLC、IINA、QuickTime、Windows Media Player。
- Adobe：psd/psb→Photoshop；ai/eps→Illustrator；indd/idml→InDesign；prproj→Premiere Pro；aep/aepx→After Effects；另 sketch→Sketch、fig→Figma。
- 编程/工程：按语言映射 JetBrains（go→GoLand、py→PyCharm、ts/js/html/css→WebStorm、java→IDEA、c/cpp→CLion、cs/sln→Rider、rb→RubyMine、php→PhpStorm、sql→DataGrip、rs→RustRover、swift→Xcode）+ 工程文件（xcodeproj/xcworkspace→Xcode），其后追加通用编程类（vscode/cursor/zed/sublime 等）。同一扩展命中多条规则时按规则声明顺序合并去重。

## 验收

- `packages/desktop/test/open-with/fileOpenAppConfig.test.ts`：扩展名→应用 id 解析（顺序、去重、大小写、未知扩展为空）；规则表 appIds 全部可解析。
- 菜单：.xlsx 在装有 WPS/Office 的机器上出现「用默认应用打开 / WPS / Excel / Numbers / 编辑器… / 复制路径」；未装任何格式应用时与现状一致。
- Cmd/Ctrl+点击 .docx 直接唤起系统默认应用（如 WPS）；无默认应用或 Web 端时回落内置预览；不可预览格式在预览侧栏展示既有「不支持」占位。
- 远端 workspace：不出现「用默认应用打开」与格式应用。

## 后续项（本轮不做）

- 工具摘要行（ToolSummaryRow）的修饰键+点击：需将 `onOpenFileLink` 回调签名扩展为携带事件，涉及 renderers 全链路。
- PreviewPane 头部「在编辑器中打开」菜单接入格式应用列表。
- Linux 端桌面应用检测（当前与编辑器检测一致返回空）。
