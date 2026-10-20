# 原生 CLI 会话导入

Codex/Claude 共享的读取、解析、快照副本和导入组织流程作为一个适配器边界受管；repo/parser 只服务该边界，跨域调用使用 contract。

CLI/runtime 的 createImportedSession 拥有会话事实；导入层只提交创建请求、保存必要展示副本并更新对应组织/呈现字段，不恢复 TaskIndexRepo 旧整行写路径。重复 sessionId 幂等，用户已续聊/改名的会话不得被源 rollout 覆盖。

源 workspacePath 用于磁盘访问，workspaceIdentity 用于隔离；失败回收仅清理由本次创建的副本。已有 Node 导入测试覆盖真实 parser/持久化流程。
