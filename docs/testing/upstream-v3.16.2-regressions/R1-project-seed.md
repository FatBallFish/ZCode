# R1：项目目录丢失的修复与恢复验证

## 已确认事实

当前 profile 的项目首次迁移已记账，但项目/roots 为空。相同 profile 的历史日志存在非空已保存清单，后续投影把清单写为空；旧品牌 profile 是另一份数据，未用于恢复。源码存在未提供设置上下文也能把首次迁移记账为空的路径，具体历史写者仍未确认。

修复由设置 owner 提供不执行投影的严格只读快照；首次本机项目迁移缺上下文即失败，不写迁移账本。已有组织态继续只由 project-storage 持有。投影在项目表全空但仍有本机项目清单时显式失败，软删除与 conversation-only 不受影响。未改已发布 migration SQL、ID、checksum 或 CLI 存储。

## 单元验证

隔离 runner 下执行：

```sh
mise exec -- node scripts/run-isolated-tests.mjs pnpm exec vitest run \
  packages/services/src/project-storage packages/services/src/remote-projects \
  packages/services/test/tasksStartupPreparation.test.ts --maxWorkers=1
```

97 项通过。新增测试覆盖缺失上下文、绕过投影读取、损坏源文件保留、既有账本不再读种子、完整恢复、数据库/设置/源指纹变化、软删除组织态、非法/远端源、缺失迁移/本机 owner、既有任务归属及触发器越权写入回滚。触发器改变 title/pinned 的新增测试已先失败，再补任务非 project_id 全列指纹后通过。

选定三文件覆盖率：statements 96.42%、branches 82.75%、functions 94.44%、lines 98.07%；恢复实现 statements 99.03%、branches 90.24%、functions 100%。该覆盖率不代表整个应用。

证据：`/tmp/mikiko-project-repair-targeted.json`、`/tmp/mikiko-project-repair-coverage.log`、`/tmp/mikiko-project-repair-facts-red.log`。新文件定向 Lint 无警告/错误；E2E 类型检查通过；架构检查 new/baseline violations 均 0。根级 typecheck/lint 由集成任务报告。

## 受控恢复

先在权限0700的真实快照副本验证：21 项目/21 roots，42 个任务赋归属，51 个保留未归类；全部93个任务非 project_id 列、其余表、设置原始字节和 CLI 备份保持不变。

关闭 Dev 后父任务执行正式 dry-run/apply，独立只读复核：21 项目/21 roots、42 赋归属、62 未归类、104 任务，其中4个空项目。只变化 projects/project_roots/tasks，全部104个任务非 project_id 列及其余表、设置字节保持不变。较早快照增加的11个空占位行全部保留，未擅自删除或归位。

恢复源、计划、数据库备份及逐表证据位于受限私有目录；父任务另复制到 `.mikiko/recovery-backups` 的持久备份，定位文件 `/tmp/mikiko-project-recovery-durable-backup.json`。原始私有临时目录定位文件 `/tmp/mikiko-project-recovery-location.json` 与 `/tmp/mikiko-project-recovery-formal-input.json`。它们包含个人数据，不应提交到 Git。正式独立复核文件为该目录 `formal-repair-backup/independent-verification.json`。

## Electron 验收

新增 `conversation-session-project-seed-upgrade` case 使用独立 HOME、真实旧 tasks schema、三个实际临时目录及空/置顶/普通项目清单；由真实 Host 执行迁移。检查目录和会话 UI、刷新、SQLite 归属及零模型请求，不在测试内填充新版 projects 表。

fresh Desktop Main/Host/Renderer 构建成功。WDIO 首轮及轻载重试均在创建 WebDriver session 阶段超时（各0通过/1失败），尚未进入业务断言；verbose ChromeDriver 日志确认 Electron 读取 Documents 下 immutable main.js 时得到 OS `EPERM`。独立 shell 运行同一构建可在约6秒内初始化 Main/Host/CDP 页面，未见项目迁移错误。未修改 TCC 或加长超时；框架用例仍为 pending，不能报告为通过。

证据：`/tmp/mikiko-project-repair-real-electron.log`、`/tmp/mikiko-project-repair-real-electron-retry.log`、`/tmp/mikiko-project-repair-chromedriver.log`。隔离 shell launch + CDP 的实际 UI/SQLite 补证已通过：启动前无 projects 表、只有2条旧会话与3个已保存 roots；真实 Host 首次迁移后3项目/3roots与2会话归属正确，置顶及 cwd 保留，页面刷新后项目顺序与内容一致。等待 React 门禁及 HTML 启动遮罩都消失后截图已目视复核，空项目、置顶会话和普通项目会话均可见。补证没有执行模型请求抓包断言，不能替代含零请求检查的 WDIO 框架门禁。

补证日志 `/tmp/mikiko-project-repair-cdp-supplement.log`，before/after/SQL 与 PNG 在 `packages/desktop/.e2e-artifacts/R1-cdp-supplement/`。初次补证自设 TMPDIR 太长，触发 Unix socket EINVAL；修正为短的独立 `/tmp/mikiko-r1-cdp-*` 后再次完成所有断言，最终运行无该错误。隔离 Electron 已退出、临时 socket 目录已清理。正式 profile 的启动和只读 UI 检查由父任务执行。
