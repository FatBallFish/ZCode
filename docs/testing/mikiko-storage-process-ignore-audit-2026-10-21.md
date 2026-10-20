# Mikiko 数据目录、进程与忽略文件复核

## 核查结论

| 项目                 | 结果与处理                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 业务数据与配置根目录 | 原已正确，未修改解析或路由。App 配置/项目索引为 `~/.mikiko/v2`，Agent 配置/数据库为 `~/.mikiko/cli`。当前真实 profile 三类文件均存在，CLI 没有旧 `.zcode` 存储覆盖，重启后仍显示 21 项目。                                                                                              |
| 自有可编译进程       | 补齐两个原生辅助程序 `mikiko-window-bounds` / `mikiko-browser-import-helper.exe` 的构建、装包、加载、签名测试路径；Windows 自建服务/管道/manifest 品牌同步。Server CLI/Core、HTTP/stdio、relay 入口显式设 Mikiko 标题。旧 provider/窗口标签归一只作用于显示名，业务 ID/工作区路径不变。 |
| 工作区忽略文件       | 原文件名已为 `.mikikoignore`，保持。新模板/分区标记补齐 Mikiko；兼容读取旧 ZCode 标记，保留默认段编辑和自定义区。维持缺文件时不自动落盘、显式保存/同步才写文件的既有行为。                                                                                                              |

Electron 自身 userData/sessionData 仍使用系统 appData 下的 Mikiko/Dev 路径；这是浏览器缓存等运行数据的既有位置，未更改。业务配置和项目索引没有迁出 `.mikiko`。第三方 Electron/Node 二进制与未提供源码的官方 CUA producer 身份保持原样；Windows 导入 Helper 是仓库自建程序，已按可编译产物处理。内部握手协议兼容值不作为进程名称。

## 代码边界

修改上游 ignore 文件触发架构准入，按规则登记 workspace-file-ignore 模块，将原实现移入 adapters，通过 index.ts / contract.ts 公开入口提供相同操作；FileService RPC、文件原子 IO、规则来源及业务目录均不变。未刷新架构 baseline，政策只增加模块声明。

## 验证

- 先红：process/ignore 目标测试 5 项失败；修复后目标 9 文件 **128/128** 通过，包含实际文件读写、旧分区同步/恢复、自定义规则、进程显示名、默认 Windows 打包加载路径和签名保护。
- CLI telemetry bootstrap **4/4** 通过；默认服务名为 mikiko-cli-agent。
- `pnpm typecheck` 实际退出 0；`pnpm lint` 0 errors / 174 warnings；changed architecture 最终 0 violations。
- CLI 完整构建及插件暂存成功，标准 `pnpm dev:desktop` 已重新启动相同 profile。
- macOS Swift 产出 arm64/x86_64 universal 二进制，实际运行 ps 名为 mikiko-window-bounds，stdout 是有效窗口列表 JSON，测试辅助进程已退出。
- Source Server `version` 真实入口退出 0，退出探针显示 process-title=mikiko-server。首次使用不支持的 --help 参数退出非零，未记为命令通过。
- 新 Dev 实际进程树：Mikiko Dev、mikiko-host-local-3、mikiko-cli、mikiko-node-repl-mcp，以及第三方 Electron Helper；未发现 zcode/zai 进程名。CDP 页面 Mikiko、21 项目、无启动遮罩。
- 尝试旧 file-mention 浏览器夹具时因缺 TabStoreProvider，在加载编辑器前失败；该 pending 夹具没有改动，未把它算作通过，也没有为本次命名改动扩大 UI 修复范围。

Windows C# 原生程序无法在本机 macOS 进行 Windows 实机编译/运行；源码、manifest、打包和默认加载路径已同步并经现有模拟测试验证。没有部署线上 relay 或发布安装包。

日志位于 `/tmp/mikiko-brand-*.log`，仅用于本地诊断；报告不复制业务配置正文或凭据。

最终 `pnpm verify:pre-push` 实际退出 0：SQLite schema 8/8、架构测试 36/36、changed architecture 0 violations。affected 命中 2113/2113，按仓库现有规则跳过全量 UT，没有执行这 2113 个规格；本报告的 128+4 项为独立实际执行结果。
