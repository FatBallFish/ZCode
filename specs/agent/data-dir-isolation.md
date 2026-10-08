# Agent 数据目录隔离（~/.zcode → ~/.mikiko）

## 背景与问题

- 会话「调用轨迹」读取侧（`resolveModelIODirs`）只认 `~/.mikiko/cli/{debug,rollout}`，但 Agent
  写入侧目录由配置项 `storage.dir` 派生，其默认值仍是 `~/.zcode`（contracts `DefaultConfig.storage`）。
  写读失配导致所有会话的调用轨迹永远为空（UI 显示「暂无模型调用记录」）。
- `~/.zcode` 同时是官方 ZCode.app 的数据根。Mikiko Agent 与官方 CLI 在同一台机器并行使用时共享
  `db.sqlite`、`log/`、`debug/`，互相踩踏且无法按品牌归属清理。
- 品牌重塑提交（93d0a79）已把日志硬编码、凭据、telemetry 等部分路径切到 `~/.mikiko`，但漏掉了
  配置默认值这一派生根，造成「同一进程一半数据在 `.mikiko`、一半在 `.zcode`」的分裂现状。

## 产品规则

1. Mikiko Agent（apps/zcode-cli）的全部持久化数据默认落在 `~/.mikiko`，不再读写 `~/.zcode`；
   与官方 ZCode 实现目录级隔离。`storage.dir` 配置项仍可显式覆盖默认值。
2. 不迁移、不兼容读取历史数据：
   - `~/.zcode/cli/{debug,rollout}` 下的存量 model-io 文件不再可见；
   - `~/.zcode/cli/db/db.sqlite` 中的存量 session 记录不迁移；
   - `~/.zcode/workflows`（全局）与项目内 `.zcode/workflows` 的存量保存工作流不再列出。
3. App 更新后的老会话继续对话：
   - 任务列表来自 host 侧任务索引（`~/.mikiko/v2/tasks-index.sqlite`），与 agent db 无关，
     老会话更新后仍出现在列表中；
   - 点开老会话 resume 时，agent 在新库找不到 session，走既有 `session missing` 错误路径
     （除 legacy Claude 导入历史外不降级重建）；此时不产生新模型请求，自然无新轨迹记录——
     「能记录就记录，记录不了就不记录」由写入路径全局跟随 `storage.dir` 自动满足；
   - 老会话在 agent 新库中不存在后，不提供自动迁移。
4. 登录凭据已落在 `~/.mikiko/v2/credentials.json`（`resolveSharedZCodeCredentialsPath`），
   切换后登录态不受影响。

## 状态所有者

- Agent 存储根：`apps/zcode-cli/packages/contracts/src/config/index.ts` 的
  `DefaultConfig.storage.dir` / `storage.sessionDbPath`。`storage.dir` 是 plugins 存储、
  skills 存储、MCP 存储、model-io、memory、session db 等派生目录的唯一事实源。
- Agent config.json 位置：`adapters/src/config/file-config.adapter.ts` 的 `DEFAULT_BASE_DIR`。
- Host 轨迹读取根：`packages/services/src/zcode-agent/modelTrajectoryFileTail.ts` 的
  `resolveModelIODirs()`（`~/.mikiko/cli/{debug,rollout}`，本次无需改动）。

## 改动清单（默认值/常量，不改接口）

| 位置                                                                       | 改动                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/contracts/src/config/index.ts`                    | `storage.dir` → `~/.mikiko`；`sessionDbPath` → `~/.mikiko/cli/db/db.sqlite`                                                                                       |
| `apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts`       | `DEFAULT_BASE_DIR` → `~/.mikiko/cli`（config.json 位置）                                                                                                          |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`                  | `ZCODE_MAILBOX_ROOT` 默认 → `~/.mikiko/mailbox`                                                                                                                   |
| `apps/zcode-cli/packages/telemetry/src/bootstrap.ts`                       | telemetry-state → `~/.mikiko/v2/telemetry-state.json`                                                                                                             |
| `apps/zcode-cli/packages/debug/server/sources.ts`                          | log/db 调试源 → `~/.mikiko/cli/...`                                                                                                                               |
| `apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts`            | `SAVED_WORKFLOW_PROJECT_DIR`/`SAVED_WORKFLOW_GLOBAL_DIR`/`workflowRunsDir` → `.mikiko`（修复与 `script-workflow-utils.ts` 既有 `.mikiko/workflows` 判定的不一致） |
| `apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-entry-file.ts` | `workflowRunsDir` 重复定义同步 → `.mikiko`                                                                                                                        |
| `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts`               | 兜底 `getModelIOBaseDir` 死代码同步 `.mikiko` + 修正过时注释                                                                                                      |
| `packages/desktop/src/main/exportLogs.ts`                                  | computer-use 运行日志导出路径 → `~/.mikiko/computer-use/run`（修复与 `services/node.ts` 既有 `.mikiko` 根的不一致）                                               |
| 各处注释/工具描述                                                          | `~/.zcode` 表述同步为 `~/.mikiko`                                                                                                                                 |

## 验收场景

1. dev 桌面新建会话并发送消息：`~/.mikiko/cli/debug/model-io-<taskId>.jsonl` 生成，
   会话「调用轨迹」面板能显示该次模型调用记录。
2. 打包版（`ZCODE_RUNTIME_ENV=production`）同理落到 `~/.mikiko/cli/rollout`。
3. 更新后点开老会话：任务列表仍显示老会话；resume 报 session missing 错误提示（不 crash）；
   新建会话不受影响。
4. 同机并行使用官方 ZCode.app 与 Mikiko：`~/.zcode` 与 `~/.mikiko` 下各自独立产生数据，
   Mikiko Agent 不再写 `~/.zcode`。
5. 现有单测中硬编码 `~/.zcode` 的断言随默认值更新，测试全绿。

## 风险与取舍

- config.json 位置切换后，CLI 独立运行时的本地配置回到默认（provider/model 等需重配）；
  desktop 场景配置由 host 经协议下发，影响面小。
- 存量保存工作流（全局与项目档）、存量轨迹、agent 侧存量 session 均按「不迁移」接受丢失。
