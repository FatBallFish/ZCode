# 工作区文件搜索忽略规则（.mikikoignore）

> 2026-10-08 定稿：规则文件由 `.zcodeignore` 更名为 `.mikikoignore`（品牌清扫收尾）。不做历史兼容：旧 `.zcodeignore` 不读取、不迁移，下次搜索按初始内容规则重新创建 `.mikikoignore`。

## 语义

`.mikikoignore`（workspace 根目录，gitignore 语法）是 ZCode 文件搜索的唯一忽略规则文件，只影响三个搜索场景：`@` 文件候选、Command Center、文件树搜索。**不影响**文件树浏览、文件上传、Agent 的文件访问。

## 状态所有者与事件顺序

- **唯一所有者是 Host 侧 `workspaceFileIgnore.ts`**（`packages/services/src/file/`）；规则解析委托 `ignore` npm 包（gitignore spec 2.22），禁止手写解析。UI 设置页只通过 `readWorkspaceFileSearchIgnore` / `transformWorkspaceFileSearchIgnore` / `writeWorkspaceFileSearchIgnore` 三个接口读写，不自行落盘。
- 扫描链路：`searchWorkspaceFiles` → `ensureWorkspaceFileIndex` → `loadWorkspaceFileSearchIgnoreRules(rootPath)` → 全量遍历（`isWorkspaceFileSearchPathIgnored` 逐条剪枝）。索引缓存 60s TTL + `.mikikoignore` mtime/size 指纹签名，规则编辑保存后下次查询即失效重建。
- 创建语义：文件不存在 → 原子写（同目录临时文件 + rename）。初始内容 = 根 `.gitignore` 拷贝（无则模板说明头）+ 同步标记 + 内置默认排除段（与 gitignore 区去重）+ 默认标记 + 自定义区提示。创建后 `.gitignore` 变化**不再**影响搜索，由设置页「从 .gitignore 同步」手动重写同步区。
- fail-open 降级链：读取失败 → 内存用 `.gitignore` → 内置默认规则；创建失败同理。任何降级只 warn 一次，不阻塞搜索。

## 分区标记

文件内两个行精确匹配的标记决定设置页按钮的作用域；标记缺失（旧格式/用户删除）时分区操作退化为整体初始内容重建：

- `# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====`：其上为 gitignore 同步区，只被「从 .gitignore 同步」重写。
- `# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----`：两标记之间为默认排除段，只被「恢复默认规则」重置；其下为自定义区，任何按钮不改动。

## 接口

- `WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".mikikoignore"`（services 内部导出，唯一消费方 `fileService.ts`：指纹 stat 与索引跳过本文件）。
- `FileService.searchWorkspaceFiles` / `readWorkspaceFileSearchIgnore` / `transformWorkspaceFileSearchIgnore(transform: "sync-gitignore" | "reset-defaults")` / `writeWorkspaceFileSearchIgnore`。

## 迁移边界

无迁移代码。已存在 `.zcodeignore` 的存量 workspace：搜索时视为无规则文件，直接重新创建 `.mikikoignore`；旧文件成为死文件，由用户自行清理。本仓库根目录与 `packages/server/` 下的旧 `.zcodeignore` 随本次更名从 git 删除。

## 验收场景

1. workspace 无任何规则文件 + 有 `.gitignore`：首次搜索后根目录出现 `.mikikoignore`，顶部为 `.gitignore` 拷贝，默认段不与其重复。
2. workspace 无 `.gitignore`：初始文件为模板说明头 + 默认段，`node_modules/` 等仍被剪枝。
3. 设置页编辑保存后，下次搜索按新规则执行（指纹缓存失效）。
4. 只读 fs：搜索不失败，日志 warn 一次，规则按 `.gitignore` 或内置默认在内存生效。
