# Host database startup

Host Worker 是 app 库启动准备的唯一执行者。宿主验证 progress/done/failed 帧后更新启动状态；输入只携带数据库路径。

先读取旧 settings，再调用 project-storage 的启动入口迁移和维护索引，完成后发送 done，失败保留结构化错误及已经提交的迁移事实。所有退出路径关闭 MessagePort。此顺序避免空设置先记账、之后无法再恢复旧项目种子。

构建产物仍为 host/tasksStorageWorker.js，取消、超时及进程代际仍由宿主原有管理器负责；不改变历史 SQL、checksum 或 attachment。

Main 的公开兼容适配 `main/databaseStartupRelay.ts` 只按 startupId/sequence 转发 Host 状态、复用既有 attachment，并在 ready 后调度原 scheduler。它不拥有迁移账本、SQL 或数据库准备状态；多个窗口附着同一 Host 时继续共用该 Host 的启动事实。
