# 会话拖拽与分屏接力

Mikiko 有意保留上游 3.16.2 移除的分屏/拖拽能力。模块只有一份活动 payload、pointer drop registry 和窗口拖出提示；布局与 session 事实仍由现有 workbench placement/store 与 Host 拥有。

可见普通 pane 优先消费分屏，之后才允许拖出所属范围打开共享 Host 的独立会话窗；floating/hidden pane 不注册或接纳 drop。来源 scope、workspaceIdentity/cwd 和 remoteSessionId 必须原样传递，不根据路径猜来源。

取消/结束/卸载清理同一 tracker，不能用延时判断释放，也不能因 stale listener 双开窗口。桌面 continuous 与手机 replayable 不在此层改写。
