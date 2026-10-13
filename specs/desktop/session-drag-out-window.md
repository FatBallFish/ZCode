# 会话拖出侧栏 → 独立会话窗口打开

> 2026-10-13 定稿；2026-10-14 按自测反馈重做判定规则与轻量窗口形态。

## 交互语义（2026-10-14：文案与行为严格同源）

「松开以在新窗口打开会话」chip 的展示谓词与释放动作完全一致（同一函数计算）：

| 释放位置 | 结果 | chip |
| --- | --- | --- |
| 任意 pane 的边缘分屏区（dropEffect 被消费） | 既有分屏/叠放（不变） | 无（半区高亮接管） |
| 指针仍在「所属范围」内 | 取消（无操作） | 无 |
| 指针超出「所属范围」（含窗口外） | **打开独立会话窗口** | 显示 |

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
