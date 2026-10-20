# 工作区忽略规则

FileService 是产品入口；本模块按工作区路径读取/原子写入 `.mikikoignore`，不持有独立配置或缓存。文件缺失时只读取 `.gitignore` 和内置默认值，不自动创建。

公开入口为 index.ts / contract.ts。创建、同步和恢复使用 Mikiko 默认段标记，同时接受历史 ZCode 标记。同步只替换 gitignore 段；恢复只重建默认段；两种操作均保留自定义段。不能因品牌改名把历史文件当作无标记文件而整体重建。

忽略语法归 ignore 库实现；匹配结果只用于文件搜索，不限制 Agent 文件访问。现有 FileService RPC 和异步原子写入语义保持一致。
