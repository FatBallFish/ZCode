# 会话拖出侧栏 → 独立新窗口打开

> 2026-10-13 定稿（自测反馈第 5 条）。目标：把会话列表中的会话拖出到侧栏以外且未落在
> 会话展示页时释放，在新的主窗口打开该会话；主窗口列表保留该会话，两窗口可同时打开。

## 交互语义（三分支，与既有分屏拖放并存）

| 释放位置 | 结果 | 引导 |
| --- | --- | --- |
| 会话展示页 pane 的边缘分屏区（32% 边带） | 既有分屏/叠放（不变） | 半区高亮（既有） |
| 会话展示页中部（无分屏区） | 无效果 | 无 |
| 侧栏内 | 取消（拖回原地） | 无 |
| 侧栏以外的非展示区（标题栏等）/ 窗口外 | **新主窗口打开该会话** | 跟随指针的「松开以在新窗口打开」chip |

## 链路与所有权

```
[renderer] 会话行 dragStart（HTML5 通道 / 分组视图 dnd-kit 指针通道）
  → workbenchWindowDragOut.trackSessionDragForWindowOpen(payload)
      dragover(capture) 持续更新：elementFromPoint 判定 sidebar / workbench / other
      → mode="new-window" 时 SessionDragOutIndicator 显示 chip（App 级单例）
  → dragend：
      dropEffect=copy/move → 已被 pane 消费（分屏），本模块退出
      dragover 停止更新 >300ms（指针已出窗口）或 lastRegion=other
        → platform.openSessionInNewWindow(payload)
[main] ipcMain.handle(OpenSessionWindow)
  → 校验（本地 workspace 限定；远程会话拒绝 remote-session-not-supported）
  → createWindowInstance({ restoreSession:true, initialWorkspacePath,
      initialWorkspaceIdentity?, initialTaskId: sessionId })
  → loadWindow 注入 URL query（initialTaskId/initialWorkspaceIdentity）
[renderer 新窗口] main.tsx 读 query → Root props
  → useRootPlatformEffects：addTab(workspace) + setActiveTaskId(taskId)
```

- 位置/状态所有者：`useSessionWindowDragOutStore`（renderer 单例，仅拖拽期存活）；
  窗口创建唯一所有者是 main（复用 `createWindowInstance`，不新开窗口类型）。
- 分屏高亮区与 chip 互斥：WorkbenchPane 在 dropSide 非空时向
  `setWorkbenchDropZoneActive(paneId, true)` 登记，引导据此让位。
- HTML5 通道在指针离窗后无事件可用，「窗口外释放」= dragover 停止更新 >300ms
  ∧ dragend 的 dropEffect 未被消费；指针通道（dnd-kit 有 pointer capture）用
  坐标越界判定。

## 双窗口同会话的同步边界

- 新窗口 spawn 自己的 window-scoped Local Host；两个 host 观察同一份磁盘会话状态
  （task index / session store），列表与历史经各自 host 的索引观察刷新。
- **运行 lease 单所有者**：会话运行（CLI runtime）由 TaskRunLease 的 ownerHostId
  全局唯一持有，跨 host 抢占式路由；两个窗口同时发消息仍串行 admission，不会双跑。
- **实时流以 owner 窗口为准**：token 级实时流只投递到 owning host 对应窗口
  （desktop-continuous 链路）；非 owner 窗口经索引/观察路径刷新（秒级，非逐 token）。
  这是 v1 的明确取舍，后续如需逐 token 镜像再走 taskRealtimeBus 广播改造。
- 远程 workspace 会话暂不开放新窗口承载（连接复用与远端 runtime 归属另议），
  main 侧显式拒绝。

## 验收

1. 默认列表拖会话到 pane 边带 → 分屏（回归不变）；中部释放 → 无效果；拖回侧栏 → 取消。
2. 拖到标题栏/窗口外 → 出现引导 chip，释放后弹出新的主窗口并直接定位到该会话；
   主窗口列表仍含该会话。
3. 分组视图（指针通道）拖出窗口边缘释放 → 同 2。
4. 在新窗口向该会话发消息 → 主窗口列表该会话更新（updatedAt/状态刷新）；
   运行中两窗口不产生双跑。
5. 远程会话拖出 → 无引导、无新窗口（no-op）。
