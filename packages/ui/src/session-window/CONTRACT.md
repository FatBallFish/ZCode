# 独立会话窗 UI

来源窗口已有 Host attachment/CLI runtime 拥有会话事实；本窗口只持有导航、面板和编辑草稿。采用 desktop-continuous，关闭时只销毁自身 renderer/attachment。

浏览器、文件、终端、审查与辅助会话面板在本窗口本地渲染。只有主窗口专属 automations 导航通过既有 IPC 桥转发；不重建 Agent/Host，不复制接纳队列。
