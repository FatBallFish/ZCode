# Mikiko 融合后的隔离 Electron 验收

采用 INT-E2E-01/02/03（case catalog/coverage matrix）作为 pending 候选，以真实 Electron UI 动作及 Git/SQLite/磁盘/Host metrics/loopback wire 断言验收融合；没有人工review不转正、不做Docker admission。

- 使用独立 `.e2e-home-integration-*`，runner 在启动 App 前写自建远控配置 `enabled:false` 和 loopback 端点，不能读写个人正式profile。helper与runner都优先新MIKIKO_E2E_HOME_DIR，旧ZCODE键仅缺省兼容；cleanup同样校验隔离HOME，不能在前置guard失败后清理旧个人目录。
- Provider 仅使用 case-local replay，断言 loopback base 与 replay 模式。语音使用 Main 的 denied 权限 fixture，不获取真实麦克风、不下载语音模型；远控检查自建入口与配置归因，不建立生产连接。
- Electron41.0.3 实际Chromium146.0.7680.80；runner 的显式私有driver缓存应使用146，而非147，不覆盖全局driver或现有App。
- Electron系统进程指标/任务管理器的cron utility进程名为 `mikiko-cron-scheduler`，语音worker为 `mikiko-voice-engine`，与既有 `mikiko-host-*` 一致；调度/语音协议、Host所有者及持久化任务不随名称变更。
- E2E store开关由一个有效值驱动：新 `VITE_MIKIKO_E2E_STORE_BRIDGE` 优先，缺失时兼容旧 `VITE_ZCODE_E2E_STORE_BRIDGE`；Vite双写同一值，新键显式关闭不能被旧键打开，普通产品test环境不隐式暴露store。
- E2E 父 runner 是 run/shard 的 HOME、run ID、artifact 与网络捕获目录唯一分配者。新 `MIKIKO_E2E_*` 优先，缺失时兼容旧键；子进程双写同一有效值，不能让旧 reporter 与新 WDIO 配置产生不同 run ID 或清理不同 HOME。直接 WDIO 入口的 reporter 同样初始化新旧 run/artifact 键。
- Web官方账号回调只完成账号业务：canonical share/v4回调同时识别ZAI `code`、BigModel `authCode`、OAuth `error`，都要求state；旧已登记回调路径保留显式兼容。该修复不能装配Relay V2设备/token入口或替换自建Mikiko ID远控。

复用仓库WDIO和写时复制的隔离app产物。类型检查完成后再构建，禁止把被tsc覆盖的Host入口作为已验证build复用；失败留真实截图、JSON证据和隔离HOME，不用源码/CSS断言或条件跳过伪造功能通过。
