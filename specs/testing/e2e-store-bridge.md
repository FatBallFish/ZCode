# Renderer E2E 诊断开关

显式 `VITE_MIKIKO_E2E_STORE_BRIDGE=1` 启用既有诊断能力，`VITE_ZCODE_E2E_STORE_BRIDGE` 只用于旧纯测试夹具兼容。新键存在时以新键为准，包括显式 0/空值；不存在时才读取旧键。没有 window 或没有显式 1 都关闭，MIKIKO_ENV=test 不能独立启用。

所有 store/事件延迟诊断与测试网页凭据信任都读取同一 shouldExposeE2EStoreBridge owner。构建 writer 与 Vite define 必须注入同一 effective 值；可以保留原调试全局兼容名，不创建第二份 Zustand store 或全局状态。

Desktop E2E 构建缓存指纹同时包含新旧两个输入键；任一值变化都使缓存失效，不能把关闭诊断能力的产物复用到显式开启的回放。

验收包括新名启用、旧名兼容、新名关闭压过旧名开启、SSR 关闭、默认关闭，以及桌面 WDIO renderer marker/探针就绪。
