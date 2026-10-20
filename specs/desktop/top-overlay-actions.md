# 桌面顶部操作唯一性

- sidebar toggle、任务后退和前进由 DesktopTopOverlay 各渲染一个入口；平台差异只改变图标和留白，不重复按钮组。
- 所有操作位于同一个 pointer-events:auto / app-region:no-drag 容器，拖动区不能覆盖点击。
- 后退/前进可用性继续由导航 owner 提供；手机远控的 hideTaskNavigationButtons 仍隐藏导航。
- 验收覆盖 macOS/Windows/Linux，展开/收起侧栏、导航禁用、每次点击一次回调和真实浏览器命中。
