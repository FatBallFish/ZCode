# Dock 未读角标（unread badge）语义

> 2026-09-28 排障定稿：用户 badge 挂死 82 的根因是远端 workspace 内存未读 + 双桶/多窗口重复计数 + 归档不清未读，四项修复一并落地。

## 语义

- 角标 = 所有 workspace 中「后台进入终态（completed/error/interrupted 且非当前查看任务）且未被点开」的任务数；数据源为任务 meta 的 `unreadAt`（sqlite `tasks.unread_at`）与远端 workspace 的内存态（`taskUnreadByTaskId`/optimistic overlay）。
- 每窗口上报其可见 workspace 集合内的总数；主进程 `sumWindowUnreadCounts` 按 workspace 集合签名对窗口去重（同集合取最大值，未上报集合的窗口按窗口独立）。
- 计数去重键统一为 `workspaceIdentity?.trim() || workspacePath` + taskId（`countAllUnreadTasks` 主分支与 fallback 分支一致；fallback 从桶内 task meta 取 identity，取不到才退桶 key）。

## 清除路径

1. 点开任务 / 标记已读：`setTaskUnread(false)` 清 sqlite + 内存。
2. 手动归档：`archiveTask` SQL 同步置 `unread_at = NULL`（自动归档 `archiveStaleTasks` 同一语句）；UI `removeTaskState` 清内存。
3. 远端 workspace 断连（`RemoteSessionClosed` 降级 tab 时）：`clearWorkspaceUnreadState` 清双桶内存未读；重连后新终态会重新标未读，语义不损失。
4. 远端 workspace 显式移除（远程历史删除）：同上清理。

## 验收

- `packages/desktop/test/unreadBadge.test.ts`：同集合窗口去重（取 max）、不同集合求和、空集合独立。
- `packages/ui/src/lib/unreadTaskCount.test.ts`：双桶主分支/fallback 归一、本地任务按桶 key、无未读为 0。
- 断连/移除后 badge 立即下降；归档带未读的任务后 badge 下降且不再复活。
