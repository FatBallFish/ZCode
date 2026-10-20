# 会话拖出侧栏 → 独立会话窗口打开

> 2026-10-13 定稿；2026-10-14 按自测反馈重做判定规则与轻量窗口形态。

## 交互语义（2026-10-14：文案与行为严格同源）

「松开以在新窗口打开会话」chip 的展示谓词与释放动作完全一致（同一函数计算）：

| 释放位置                                    | 结果                  | chip               |
| ------------------------------------------- | --------------------- | ------------------ |
| 任意 pane 的边缘分屏区（dropEffect 被消费） | 既有分屏/叠放（不变） | 无（半区高亮接管） |
| 指针仍在「所属范围」内                      | 取消（无操作）        | 无                 |
| 指针超出「所属范围」（含窗口外）            | **打开独立会话窗口**  | 显示               |

「所属范围」按会话来源划分：

- 项目视图的会话：所属项目行 + 其会话列表整块（`data-session-drag-owner-scope="project"`
  锚在 WorkspaceSidebarItem 根元素）；范围内=取消，超出即开窗（跨到其他项目区/展示页/
  标题栏/窗口外均算超出）。
- 置顶会话：置顶分区整块（`data-session-drag-owner-scope="pinned"`）；完全脱离置顶区
  即开窗，范围内取消。
- 找不到锚点时回退整个侧栏（拖动未离开侧栏 = 取消）。

实现要点（workbenchWindowDragOut.ts）：

- HTML5 DnD 指针离开应用窗口后 dragover 停发、落点不可读 →「dragover 停止更新 >300ms」
  判定出窗；期间节拍器把提示切成 new-window（chip 冻结于最后位置但保持可见），保证
  「拖出窗外 → chip 在 → 释放开窗」一致。
- **tracker 单例**：源行在虚拟列表重渲中被卸载时 dragend 不派发，残留 window 监听会让
  下一次拖放触发两次开窗（自测双开 bug）。每次 dragStart 先释放上一个 tracker。
- main 侧另有 1.2s 同源同会话去重闸门（recentSessionWindowOpens），双保险。
- 分组视图（dnd-kit 指针通道）：指针越出视口才开窗（保持原规则）。

## 右键菜单入口

会话右键菜单新增「在新窗口打开会话」（TaskActionMenuContent，位于「在分屏打开」之后），
仅桌面本地会话注入（远程会话入口不显示，与拖出一致）；动作等价拖出释放。

## 轻量会话窗口（2026-10-14 重做）

新窗口不再是完整主窗口克隆，而是 `windowKind: "session"` 的轻量会话窗：

```
[main] OpenSessionWindow（去重后）
  → createSessionWindowInstance → createWindowInstance({windowKind:"session", restoreSession:false,
      initialWorkspacePath/Identity, initialTaskId})
  → 复用既有 host/端口/窗口生命周期管线；loadWindow 注入 query（windowKind=session 等）
[renderer] windowKind === "session"
  → 跳过启动 Loading 壳（DB 准入握手照常，ready 即进）
  → SessionWindowRoot：Root 同款核心 Provider 栈（lucide/tooltip/services/platform/store/
    tab/diffs）+ V4WorkspaceChatArea(workspacePath, sessionId)
  → 仅渲染会话页；无侧栏/页签/命令面板/onboarding
```

- 会话窗口内 `/new` 首发创建的新会话就地跟进（onSessionCreated 更新本地 sessionId）；
  会话被删除则窗口关闭。
- 主题与主窗口共用同一 localStorage 键（同 partition）。
- 提速来源：不渲染 GlobalDatabaseStartupLoading、不恢复页签、不走完整 App 引导；
  host 进程 spawn 仍是主要启动成本（复用管线，v1 不做预热）。

## 双窗口同会话的同步边界（不变）

- 新窗口 spawn 自己的 window-scoped Local Host；运行 lease 单所有者，双窗串行 admission。
- 实时流以 owner 窗口为准；非 owner 窗口经索引观察秒级刷新。远程 workspace 会话不开放。

## 验收

1. 项目视图：会话在所属项目块内拖动/释放 → 无 chip、无动作；超出项目块 → chip 出现，
   释放即开轻量会话窗；落在 pane 分屏区 → 分屏（回归不变）。
2. 置顶会话：置顶区内取消；完全脱离置顶区 → 开窗。
3. 拖出应用窗口外（dragover 停更）→ chip 保持，释放开窗。
4. 一次释放只开一个窗口（连续快速重复拖放不同会话不受去重影响——按 sessionId 区分）。
5. 新窗口：无 Loading 屏、无侧栏/页签，直接展示目标会话；可在其中继续对话。
6. 右键会话 →「在新窗口打开会话」→ 同 5；远程会话无此菜单项。

## 会话窗口 Header 与终端（2026-10-14 补充）

- SessionWindowRoot 顶部挂载 WorkspaceHeader（variant=task）：左=会话标题/更多菜单，
  右=在 XXX 打开/分享/帮助/终端切换；Header 内层 `[app-region:drag]` 兼作窗口拖动区
  （按钮区 no-drag）；`isSidebarVisible=false` + `compactWindowControlsInset`（mac 只
  让开红绿灯 ~96px；沿用主窗口隐藏侧栏的 pl-58=232px 大预留会把标题顶到视觉中央，
  Win/Linux 内联窗控在右侧、左侧不预留）。
- 终端面板真实可用：聊天区 + AnimatedTerminalPanel 必须挂在竖向 ResizablePanelGroup
  下（panelIds=[session-chat, terminal]）——单挂 ResizablePanel 会抛
  "Group Context not found"。
- 侧面板切换按钮经 hideSidePaneToggle 隐藏（shell 侧面板装配不在会话窗口承载范围内，
  后续如需再评估）；Win/Linux 内联窗控不受该开关影响。reload 入口为禁用态。

## 附着主窗口 Host 与面板转发（2026-10-14 二轮）

- **同 Host 附着**：会话窗口不再 spawn 自有 Local Host——`StartupWindowBootstrap
.attachToHostOfWindow`（源窗口 webContents id）→ dom-ready 时对源 Host 发
  `AttachServicePort`（desktop-continuous / scope=local，与手机远控、刷新共用机制），
  端口投递给会话窗口 renderer。同 Host 同运行时：会话状态、运行 lease、消息流与
  主窗口完全一致（实时同步，非备份）；关闭会话窗口只关 attachment 端口，源 Host
  不受影响；源窗口已关时回退 spawn 自有 Host（降级独立模式）。
- **DB 启动 relay 多窗口化**：databaseStartupRelay 按 Host 聚合（latest/控制路由/
  转发窗口集合），`attachDatabaseStartupRelayWindow` 把会话窗口加入源 Host 的状态
  转发并回放最新状态（否则会话窗口卡在启动准备，实测超时）。
- ~~面板动作转发~~（2026-10-15 面板本地化后废止，见下方「面板本地化」：侧面板改在
  会话窗口本地渲染，仅 automations 主视图仍经 `sessionWindowPanelBridge` 转发）。
  终端面板始终在会话窗口内本地承载（竖向 PanelGroup，orientation="vertical"）。

## 关闭语义：会话窗口点关闭即真实销毁（2026-10-15）

- macOS「关红点=隐藏」与 Win/Linux close-to-tray/before-close 拦截都只属于主窗口
  语义。会话窗口（`windowKind=session`）两个分支都不挂：点关闭（或 Cmd+W）直接销毁，
  Host 侧按 attachment port 关闭自行回收。
- 根因（实测 2026-10-14 dev 日志）：关闭后被 `hide()` 的会话窗口仍存活于窗口列表，
  `app.show()`（任务通知/OAuth 深链/宠物唤起/dock 路径共用）、`revealExistingWindow`
  等任何遍历窗口的唤起路径都会把它重新 show 出来——用户看到「已关闭的会话窗口又
  出现了」；且每个隐藏窗口保留完整 renderer 与 Host attachment，还会在后台周期性
  reload/重附着（同一 webContents id 多次 dom-ready attach）。
- 验收：关闭会话窗口 → 最小化主窗 → 点 Dock/通知/宠物唤起 → 只有主窗口回来；
  `BrowserWindow.getAllWindows()` 不再有该会话窗口。

## 面板本地化（2026-10-15）

- **会话窗口本地渲染侧面板**：SessionWindowRoot 调用与主窗口 App 同款
  `useAppPanels`（窗口内独立 sidePaneState 实例）+ `AnimatedSidePanePanel`，水平
  ResizablePanelGroup `[session-conversation-column, browser]` 包住会话列（竖向
  聊天+终端）与侧面板——与主窗口 workspace-body-layout 同构。文件预览（code
  viewer）/文件链接/代码审查（Git）/辅助对话/后台任务/子会话/工作流详情/白板等
  全部本地打开；主窗口会话切走不再影响会话窗口的面板上下文（此前转发到主窗口，
  面板落在主窗口当前活跃会话上，属串扰）。
- **审查/辅助对话/终端窗口间独立**：面板状态是窗口内 React 实例 + taskSidePaneMemory
  按 workspace 持久化，两窗口各持各的打开集；终端已在会话窗口本地承载。
- **挂载策略**：侧面板首次出现（打开或存在 tab）前不挂 ResizablePanel；之后常驻
  （浏览器 guest 的 webview 需要常驻 DOM，隐藏仅收起面板），与主窗口
  「Browser Guest Host 与视图路由解耦」同一不变量。
- **布局与主窗口对齐（2026-10-15 二轮修复）**：终端/侧面板与会话区必须是「并列
  组件」而非「嵌入会话区」——外层复用主窗口 #content 的桌面外衬（`p-1 pt-0` +
  顶部 1px 拖动垫），会话区包 `data-workspace-conversation-frame` 圆角边框 section
  （终端可见时 `rounded-b + border-b`，侧面板可见时整框），终端面板常驻但由
  `useAnimatedResizablePanel({open: isTerminalOpen})` 驱动 `panel.collapse/resize`
  （只传 isVisible 不下命令会导致「开终端顶起输入框、关闭不回落」）。终端面板常驻
  且折叠为 0px，不再需要 hasOpenedTerminal 首开门槛。
- **仍转发主窗口的动作**：仅 automations 主视图（会话窗口不承载该视图）；
  `sessionWindowPanelBridge` 与主窗口分发表保留但只登记 `onOpenAutomationsMain`。
- **辅助对话固定入口**：侧面板 launcher/空态的「辅助对话」按钮与主窗口同款走
  `selectionSideChatRuntime` 命令总线（`requestSelectionSideChatOpen`），由本窗口
  挂载的 SessionPane（已注册 opener，经共享 Host 派发 createSelectionSideSession）
  创建/激活副屏 tab——不得在壳层直接传 no-op。
- 验收：在会话窗口打开文件预览/审查/辅助对话 → 面板出现在会话窗口右侧；主窗口
  同时切到其他会话，互不影响；主窗口的侧面板不受会话窗口操作影响。
- 验收（布局）：开/关底部终端与右侧面板，均与主窗口同观感（边框分隔、组件并列、
  输入框随终端开合正常回落）。

## 浏览器无缝衔接（2026-10-15）

- **模型**：tab 的物理 guest 是 `<webview>`（一个 webContents 只能属于一个窗口的
  DOM），跨窗口无法共享实时视图；采用「按窗口持有 + 关闭方向自动迁回」：
  - 创建会话窗口：不迁移主窗口 tab——正在进行的 agent 浏览器调度（CDP 在 main 侧
    按 owner 路由）完全不受影响；会话窗口浏览器面板从自己的新 tab 开始。
  - 会话窗口关闭：`browserGuestManager.migrateWindowTabs(fromWindowId, toWindowId)`
    把该窗口的活动 tab owner retarget 到源主窗口 + 拆除旧 guest（cachedUrl 保留）+
    residency 置 suspended，再走既有 restore 流程：`onRestoreTabRequested` 按
    retarget 后的 owner 路由到主窗口，载荷带 `migrated` + 缓存 `title`；主窗口
    renderer 的 restore 事件处理在 tab 缺失时按载荷创建 side-pane tab（当前视图）
    或写入目标 workspace 的持久化面板记忆（切回后以 suspended 壳出现），挂载
    webview → attachGuest（restoring + generation 校验）→ `restoreGuestState` 以
    cachedUrl 导航回原页面。
- **页面状态边界**：迁移恢复 URL/标题（新 guest 重新加载），表单等页面内 JS 状态
  不保留——与既有 LRU 淘汰恢复语义一致，诚实降级。
- **降级**：源主窗口已销毁（整个 App 只剩会话窗口）→ 不迁移，随常规清窗销毁；
  主窗口切到其他 workspace → tab 壳写入原 workspace 记忆，agent 对该 tab 的浏览器
  命令在用户点开恢复前不可用（与 suspended tab 在非活跃 workspace 的既有语义一致）。
- 验收：会话窗口打开内置浏览器 tab 并导航 → 关闭会话窗口 → 主窗口侧面板自动出现
  该 tab 并回到原 URL；agent 正在主窗口浏览器上操作时创建/关闭会话窗口，主窗口
  guest 与 CDP 调度不受扰动。

## Mikiko 上游 3.16.2 集成验收（2026-10-20）

采用新的 ProjectTree / project-sidebar 作为组织态唯一投影。保留工作树真实 workspaceIdentity/cwd、根项目聚合、路径菜单、置顶项目层级、归档和拖出开窗；投影不得变更运行时归属。独立窗口附着已有 Host，面板仍在各窗口本地渲染；未读按 task identity 去重，不引入第二份事实。手机远控继续自建服务，禁止装配 Relay V2；新增可见配置和路径使用 Mikiko。验收同时覆盖桌面 continuous 与手机 replayable 恢复，主/独立窗切换与关闭不改变共享会话运行时。

3.16.2 新的主窗口/完整视图共用顶栏避让计算，但独立会话窗继续使用 compactWindowControlsInset：macOS 仅让开红绿灯，Windows/Linux 不引入主窗口左侧浮层留白。完整视图与独立原生会话窗共存，均复用原 Host/session，不接纳隐藏 pane 的迟到拖放。
