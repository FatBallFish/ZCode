# 工作树 UI 状态

`store/worktreeStore.ts` 是唯一窗口内 owner：Host WorktreeService 注册表/磁盘状态/分支是派生缓存；工作位置是尚未发送的 Composer 意图。

缓存刷新以 requestId 拒绝迟到结果。工作树创建、删除和 Git 状态仍归 WorktreeService；首发经 CommandInbox 原子接纳，显示聚合不得改变真实 cwd/identity。草稿 key 使用 workspaceIdentity?.trim() || workspacePath。

旧 store 导入路径作为公开兼容入口保留；新代码可使用本模块 contract。
