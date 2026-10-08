# Mikiko 桌面宠物：Codex Pet 资源包兼容 + 宠物市场接入

> 2026-10-07 定稿。基于 openai/codex（codex-rs/tui/src/pets/，终端内宠物）的资源格式与动作语义，在 Mikiko 桌面端实现 OS 级桌面宠物，并接入 legeling/awesome-codex-pet 市场。

## 目标与非目标

**目标**：桌面悬浮宠物（透明置顶小窗）+ 兼容 Codex Pet 包格式（v1/v2）+ 市场浏览/搜索/安装/更新 + 宠物对 agent 运行状态的基础反应。
**非目标**：不修改 Codex 的 `~/.codex/pets`（只读导入）；不做 v1→v2 的 AI 图集升级（那是 Codex 的 AI 任务）；不做宠物编辑器/投稿。

## 包格式契约（与 Codex model.rs 对齐）

安装目录：`~/.mikiko/v2/pets/<pet-id>/`（`getAppConfigDir()` 下，与 Codex 目录互相独立）。

- `pet.json`（zod 严格校验）：`id?`、`displayName?`、`description?`、`spritesheetPath?`（默认 `spritesheet.webp`，**只允许包内相对子路径**，拒绝绝对路径与 `..` 穿越——Codex 同款防护）、`frame? {width,height,columns,rows}`、`animations?`。
- 缺省网格：帧 192×208、8 列；**行数由图集实际高度推导**：1872→9 行（v1）、2288→11 行（v2），其它高度拒绝。
- 缺省动作表（行号→语义，时长 ms，末帧加长）。帧数必须与官方图集每行**实际非空格数**一致（像素级实测：idle 行第 6/7 格、waving 第 4 格起等均为空白格）——按空格格子绘制即「闪烁」：

| 行   | 动作                               | 帧数 | 帧时长/末帧                                                       |
| ---- | ---------------------------------- | ---- | ----------------------------------------------------------------- |
| 0    | idle                               | 6    | 逐帧 1680/660/660/840/840/1920（官方 idle_animation 呼吸节奏）    |
| 1    | running-right / move_right         | 8    | 120/220，循环                                                     |
| 2    | running-left / move_left           | 8    | 120/220，循环                                                     |
| 3    | waving / wave                      | 4    | 140/280，一次性：主序列×3 后回落 idle（官方 app_state_animation） |
| 4    | jumping / bounce                   | 5    | 140/280，一次性：主序列×3 后回落 idle                             |
| 5    | failed / sad                       | 8    | 140/240，循环                                                     |
| 6    | waiting                            | 6    | 150/260，循环                                                     |
| 7    | running                            | 6    | 120/220，循环                                                     |
| 8    | review                             | 6    | 150/280，循环                                                     |
| 9–10 | look（v2 新增，16 个顺时针环视帧） | 8+8  | 150/280，一次性（正放+倒放往返；官方 TUI 未使用，Mikiko 扩展）    |

- 一次性动作（waving/jumping/wave/bounce/look）主序列重复 3 遍再回落 idle——对齐官方 `primary×3 + idle 尾巴 + loop_start` 的帧序列语义（我们用 fallback=idle 达成同样的逐帧序列）。

- 自定义 `animations` 覆盖同名牌（`frames[]`+`fps`（默认 8，≤60）+`loop`（默认 true）+`fallback`（默认 idle））；校验：帧索引 < 总帧数、fallback 存在、总帧数 ≤256。
- `submission.json` 仅市场投稿用，安装时一并保存（作者/许可展示用），运行时不读取。

## 市场协议（awesome-codex-pet）

- 源：`https://raw.githubusercontent.com/legeling/awesome-codex-pet/main/`（可被镜像设置覆盖，仅允许无凭据 HTTPS URL）。文件：`pets.json`（目录：slug/双语名/作者/分类/标签/许可/spriteVersionNumber）、`install-manifest.json`（每宠物 `petJsonSha256/Bytes` + `spritesheetSha256/Bytes` + 图集尺寸）、`categories.json`。
- **安装**（对齐官方 CLI 语义）：下载 `pet.json`+`spritesheet.webp` → 校验字节数 + SHA-256 + WebP 文件头（`RIFF….WEBP`）+ manifest id 一致 → 临时目录暂存 → 原子切换（rename）→ 失败清理暂存；覆盖已有需显式 force；现有目录含额外文件或符号链接时拒绝覆盖。
- **浏览/搜索**：拉取目录后本地过滤（slug/双语名/标签，多关键词 AND，与官方 CLI search 一致）；目录内存缓存 + 手动刷新。
- **更新**：安装时落 `.install.json`（记录来源 manifest 摘要）；「更新」= 比对远端 SHA，不同则走 force 安装。
- **预览图**：经 main 代理拉取 `assets/previews/<id>/webp/idle.webp` 转 data URL（renderer 不直连远端，规避 CSP 与被墙直连）。
- **Codex 导入**：只读扫描 `~/.codex/pets/*/pet.json`，校验合法后复制入 Mikiko 目录（源目录不动）。

## 窗口与交互（三平台）

独立 `pet.html` + 专用 preload（`window.desktopPet`，最小面）+ main 侧 `petpack://` 文件协议（仅放行已校验宠物目录内的 webp/json；参照 localMediaPreviewProtocol 的 registerFileProtocol 先例）。

- 窗口：frameless、transparent、resizable:false、skipTaskbar（仅 Windows/Linux；macOS 上 Electron 会把 skipTaskbar 映射成 App 级 Dock 图标隐藏）、alwaysOnTop（`screen-saver` 级）、hasShadow:false、focusable:false（点击不抢焦点）、**`type:"panel"` 必须与 focusable:false 同时存在**（CUA 浮窗实测：只设 focusable:false 时点击仍会激活 App、焦点落到主窗——台前调度（Stage Manager）下表现为点击/拖动宠物就把整个 App 唤到前台）、Win11 `roundedCorners:false`；尺寸 = 帧 192×208 × 0.6 缩放（约 115×125）。
- **全工作区可见**：`visibleOnAllWorkspaces: true`——桌面宠物是全桌面陪伴物，必须跟随用户跨 macOS Space / Windows 虚拟桌面；否则创建宠物时所在 Space 被切走后宠物"消失"（E2E 实测：多显示器 + 多 Space 环境下窗口存活且在渲染动画，但用户当前 Space 看不到）。
- 位置：持久化到 `AppSettings.desktopPetPosition {x,y}`（拖拽结束 debounce 落盘；夹取在屏幕可视区内）。
- 拖拽：页面捕获 pointer 事件 → IPC 增量 → main `setPosition`；按下→抬起位移 < 阈值判定为点击 → waving（一次后回 idle）。**只有主键（button 0）可开始拖拽**——右键按下会弹菜单且菜单吞掉 pointerup，拖拽会话悬空会表现为"宠物一直跟着鼠标走"；右键菜单弹出前也终止在途拖拽会话。
  - **增量必须用屏幕全局坐标（`screenX/screenY`）**，不能用视口坐标（`clientX/clientY`）：窗口本身随鼠标移动，视口坐标系下鼠标位置几乎不变，宠物只能靠事件残差推进——表现为"跟不上鼠标 + 残差噪声导致左右动画频繁抖动"（用户实测报告）。screenX/Y 与 `setPosition` 同为全局 DIP 坐标系。
  - **方向切换带迟滞**：新方向需累计 ≥16px（或单事件 ≥20px）且距上次切换 ≥200ms 才切换动画；竖直方向（上/下）统一用循环动作 `running`（`jumping` 是一次性 ×3 动作，持续拖拽会中途落回 idle）。
- 右键菜单（main Menu）：切换宠物…/宠物市场…/设置/隐藏宠物。
- **Linux 降级**：平铺 WM 无合成器时透明失效（白块）。启动探测：创建后读取 `isTransparent` 不可靠，v1 采用保守策略——设置项「不透明背景兜底」（默认关），开启后窗口带圆角深色底；文档说明主流桌面（GNOME/KDE）无此问题。
- **agent 状态联动（只读订阅）**：main 聚合 `hostRunningTaskCountMap`（既有 AgentRunningTaskCountChanged 链路）作为兜底（无会话摘要时 total>0 → 工作视觉）。会话摘要（下节）存在时按**视觉语义**映射（官方图集实测：第 6 行 waiting=对电脑敲击、第 7 行 running=原地小跑、第 8 行 review=放大镜、第 5 行 failed=垂头）：任一会话 `waiting`（等用户）→ `running`（小跑催促）；否则任一会话 `running`（进行中）→ `waiting`（对电脑工作）；否则 error+未读 → `failed`；否则 completed+未读 → `review`；否则 `idle`。启动/启用时→`waving` 一次；点击挥手播完后回到最近一次下发的状态（不滞留 idle）。
- **App 可达性（macOS）**：所有唤起路径（气泡点击/双击宠物/宠物设置菜单）统一走「无主窗口时 `ensurePrimaryWindow` 创建 → app.dock.show() → 重设 Dock 图标 → app.show() → focus」——宠物/气泡窗是 skipTaskbar 窗（**仅 Windows/Linux 设置该选项：macOS 上 Electron 会把 skipTaskbar 映射成 App 级 Dock 图标隐藏，气泡首次创建即触发 Dock 图标消失**），当它成为 App 唯一存活窗口时 Dock 图标可能被隐去；且 `dock.show()` 会把图标重置为 bundle 默认（开发态为 Electron 原始图标），必须重设。cmd+w 关闭主窗口后，宠物是唯一唤起入口——唤起回调必须能**创建**主窗口，而不只是聚焦既有窗口；气泡点击跳转对新建窗口补一次 1.5s 延迟广播（renderer 挂监听需要时间，setActiveTaskId 幂等）。宠物窗口 ready-to-show 时也防御性 `app.dock.show()`。

## 会话状态气泡（session bubble）

宠物上方常驻小气泡，展示本机各 host 进行中/待处理会话的最新状态；数据只读聚合，点击跳转，不承载会话交互（权限/选择的完整交互在 App 内完成，气泡仅展示提醒 icon）。

- **数据管道**：host（每窗口一个 utility process）从 `windowHostControllerRuntime` 投影行（`WindowHostControllerTaskRow`：liveStatus + meta.unreadAt/title + activity）过滤映射为 `PetSessionSummary`，经 parentPort 新消息 `HostResponseTypes.PetSessionSummaries` 推 main（投影变化触发 + 3s 兜底轮询，300ms debounce，JSON 不变不重发）。`SessionSummary.lastAssistantPreview`（≤120 字符）经 overlay 的 `activity.lastAssistantPreview`（activity schema 新增可选字段，加法兼容）进入投影行。
- **PetSessionSummary**：`{ taskId, workspacePath, workspaceIdentity?, title, liveStatus: running|waiting|completed|error, lastPreview?, unread, pendingKind?: permission|userInput, pendingToolName? }`。
- **过滤/排序**：liveStatus running/waiting 全保留；completed/error 在「未读（unreadAt）或终态宽限期（updatedAt 起 2 分钟）」内保留——宽限期兜底两个 gap：overlay 会话结束→meta 落库间的瞬态，以及未读标记由主窗口 renderer 写入、窗口被关时无人写 unreadAt；用户至少看到完成/失败的终态反馈。idle 不进气泡。排序 waiting > running > error(未读) > completed(未读)，同级按 updatedAt 降序；上限 6 条，超出追加「还有 N 个会话」计数行。
- **main 聚合**：`desktopHostProcess` 按 host 进程存 `Map<UtilityProcess, PetSessionSummary[]>`（host 退出清空），index.ts 拍平去重（taskKey = workspaceIdentity||workspacePath \0 taskId）后 `desktopPetManager.setSessionSummaries(rows)`。
- **气泡窗口**：独立 `pet-bubble.html` + 专用 preload（仅 `onSummaries/openTask`）；`type:"panel"` + `focusable:false` 同时存在（CUA 浮窗实测结论：少一个都会抢焦点/激活 App）、transparent（backgroundColor 显式 `#00000000`，避免首帧黑块）、skipTaskbar（仅 Windows/Linux）、`alwaysOnTop('screen-saver')`、`visibleOnAllWorkspaces`；定位在宠物正上方（水平居中，workArea 夹取，上方放不下放下方），宠物拖动/恢复位置时跟随；无符合条件的会话时隐藏不销毁。**空载荷时禁止 reposition/setBounds**——隐藏窗口被 setBounds 到纯 padding 高度（24px），macOS 透明窗会短暂显影，表现为"移动宠物后窄条气泡复活"。**初始化预热**：气泡窗口随 manager 创建即隐藏加载（预热），页面 `did-finish-load` 前到达的 payload 缓存不显示——否则首条数据发给未挂监听的页面会丢失，窗口也以未绘制状态（黑框）先显示；就绪后补发立即显示。
- **主题跟随**：载荷携带 `theme: "dark"|"light"`（main 按 `nativeTheme.shouldUseDarkColors` 解析，涵盖 renderer 的 light/dark/system 设置与系统切换）；`nativeTheme.on("updated")` 时用最近合并结果重推气泡，页面切 `body[data-theme]` 驱动 CSS 两套配色。**卡片不带 CSS box-shadow**：透明窗的阴影被裁进窗口矩形，浅色主题/壁纸上表现为圆角外的方形底色。
- **图标与交互细节**：会话进行中的 icon 为旋转 loading（CSS 动画）；气泡行单击/双击均触发跳转（幂等）。**双击宠物（400ms 内两次有效点击）唤起 App 主窗口**（不指定会话）。
- **header 与折叠**：气泡顶部 header = 会话数标签 + 清空终态按钮（垃圾桶 icon，无终态行时禁用）+ 折叠/展开按钮（chevron icon）；折叠只留 header 行，窗口高度经 `PetBubbleSetCollapsed` 联动收缩（main 侧计算高度）。
- **行关闭/清空（仅终态）**：终态（completed/error）行 hover 出现关闭按钮（× icon）→ `PetBubbleDismissTask`；清空按钮 → `PetBubbleClearTerminal`（全部终态行）。manager 维护 dismissed taskKey 集合（内存态，不落盘；重启后恢复展示），running/waiting 行不受影响且其 taskKey 自动移出集合（会话重新运行即恢复展示）。
- **首显零副作用**：层级（`setAlwaysOnTop('screen-saver')`）与 Space 行为（`setVisibleOnAllWorkspaces(true)`，**不带 `visibleOnFullScreen`**）只在窗口创建时设置一次——E2E 实测带 visibleOnFullScreen 的调用会在气泡首显（showInactive）时使 macOS 把 App 降为 accessory（Dock 图标消失）并扰动前台；更新路径也不再重复调用任何 Space API。
- **气泡行**：状态 icon（running=进行中/waiting=需要处理/completed=完成/error=失败）+ 未读点 + 会话标题（一行，超出 …）+ lastPreview（一行，超出 …）。点击行 → main 聚焦主窗口并广播 `PlatformChannels.OpenPetTask {taskId, workspacePath, workspaceIdentity?}`——renderer **用地址直连激活** tab + setActiveTaskId，不依赖 taskListCache 命中（按 taskId 反查缓存时，后台 workspace 列表未加载/过期会静默失败，用户实测"只唤起不切换"）；目标 workspace 无 tab 时回退按 taskId 反查；打开动作自身会清未读。
- **验收**：①单会话运行中 → 气泡显示标题与最新消息，宠物 running；②会话等待授权 → 气泡提醒 icon + 宠物 waiting，点击气泡 → App 前台并切到该会话；③会话完成/失败且未读 → 气泡 ✓/✕ 图标，打开后气泡行消失（未读清除）；④多会话并发 → 多行可点选；⑤全部会话结束且无未读 → 气泡隐藏、宠物 idle。

## 设置与状态所有权

- `AppSettings` 新增：`desktopPetEnabled?`（undefined=false 免迁移）、`desktopPetId?`、`desktopPetPosition?`。zod 同步更新；改 schema 后需完全重启 App（host 内联旧 schema 会剥离新字段——已有先例教训）。
- 窗口生命周期唯一所有者 = desktop main（`desktopPetManager`）：bootstrap 读设置决定是否创建；`syncImmediateAppSettings` 检测字段变化即时增删改窗口；host/renderer 不持有宠物窗口状态。
- **辅助窗边界**：宠物窗与气泡窗都是辅助窗（manager 暴露 `ownsWindow(win)`，涵盖气泡预热窗），必须从主窗口协调器的主窗候选、对话框父窗、"还有窗口存活"保活判定中排除（`getApplicationWindowsExcludingAuxiliary`）。否则启用宠物的启动序（宠物/气泡预热窗先于主窗创建）会让主窗口协调器"复用"辅助窗，App 启动后没有主界面——气泡改为创建即预热后该坑以新形态复现过一次。
- 市场服务逻辑位于 main（`desktopPetMarketService.ts`，fetch/fs 均依赖注入可单测）；纯校验/搜索逻辑在 `@zcode/shared/pets`。
- 设置页新增「宠物」分区（SettingsSectionId `pet`）：启用开关 + 当前宠物行 + 「管理宠物」进入整页子视图（复用面包屑子页模式）：已安装列表（切换/卸载/更新）+ 市场浏览（分类筛选+搜索+预览+安装）+ Codex 导入入口。

## 安全与许可

- pet.json zod 严格校验 + spritesheet 路径穿越防护 + 网格一致性 + 帧数/fps 上限（对齐 Codex）。
- `petpack://` 只放行已安装宠物目录内的文件；pet 页面 CSP 仅允许该 scheme，无远端加载。
- 市场资产 CC BY-NC 4.0（部分为作者自定义非商用条款）：按需下载不捆绑分发；UI 展示作者与许可证（来自 pets.json/submission.json）。

## 验收场景

1. 启用宠物（已安装）→ 右下角出现透明置顶宠物，idle 循环；拖拽跨屏移动，松手位置持久化，重启恢复。
2. 点击宠物 → waving 一次后回 idle；右键菜单四项可用。
3. v1 与 v2 包均能安装并渲染；v2 偶发 look 环视。
4. 市场：分类浏览、搜索（中英/标签）、预览图加载、安装进度与成功态；坏 SHA/坏头安装被拒且不留半成品。
5. 更新：manifest SHA 变化后显示可更新，更新后本地记录同步。
6. Codex 导入：`~/.codex/pets` 下合法包出现在已安装列表，源目录未被修改。
7. agent 联动：会话运行中宠物切 running，结束回 idle。
8. 卸载当前宠物 → 窗口关闭、设置回退未启用。
