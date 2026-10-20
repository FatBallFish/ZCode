# Renderer 测试能力开关

只解析 Vite/WDIO 显式 E2E opt-in，MIKIKO 新名优先，ZCODE 旧名仅兼容既有纯测试夹具。无 window/无显式 1 关闭，产品运行模式不能自动启用。

所有诊断引用同一 shouldExposeE2EStoreBridge 与既有 owner；本模块不创建任何 Zustand store、Host 或额外全局状态。测试网页临时 loopback 信任同样消费这一 gate，不能以旧键覆盖新键关闭。
