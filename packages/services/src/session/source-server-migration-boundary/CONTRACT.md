# Source Server workspace migration

AliasRepo 是 app/CLI workspace 身份解析、备份与ledger的唯一owner。调用者等待canonical结果，再绑定attachment；不会按显示路径新建第二份事实。

同一规范化workspacePath串行，失败释放本次队列但保留已提交ledger，重试从该事实恢复。任务重键与off-peak绑定冲突取消共用同一写事务。冲突错误不可自动重试；不覆盖用户已存在的目标配置。原有迁移集成测试覆盖两库提交、故障恢复与正文/身份保留，新边界测试覆盖空输入不得创建数据库。
