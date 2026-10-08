# Git Worktree：创建/管理/会话接入/侧栏并入/远控管理

> 2026-10-08 定稿（决策点 D1–D5 已由用户拍板，见 docs/plans/2026-10-08-git-worktrees-feasibility.md）。
> 参考 Codex App 的 worktree 语义：创建时 detached HEAD、随机目录名、ref 缺省取远程默认分支、分支名留给后续显式创建。

## 背景与目标

当前多会话共享同一 workspace checkout（切分支互相踩）。本功能引入 git worktree 作为会话级并行执行环境：

1. 设置新增 Worktrees 页：4 项配置 + 按根项目分组的管理列表（FR-1）。
2. 新建会话草稿新增「工作位置」：本地 / 新建本地工作树 / 现有工作树（FR-2）。
3. worktree 会话与普通会话完全同构；状态栏天然显示「分离头指针」（FR-3，零改动）。
4. `/new` 斜杠命令：按当前会话模式预选/锁定新建会话选项（FR-4）。
5. 侧栏：worktree 会话带分支 icon 徽标，且**并入根项目分组展示**（FR-5，D3）。
6. 手机远控（本地 attachment）可管理 worktree（D5）。

## 产品规则与语义（对齐 Codex）

- **创建即 detached**：`git worktree add --detach <dir> <ref>`；`git branch --show-current` 为空是预期状态，不是缺陷。
- **ref 语义**：用户在草稿分支 chip 里选「起始分支」；未选时取远程默认分支（`symbolic-ref refs/remotes/<remote>/HEAD`，回退 main/master 探测）；fetch 开关开启时先 `git fetch --prune <remote>`（无 remote 静默跳过）。
- **目录命名**：`<工作树根目录>/<repoName>-<hash4(rootPath)>/<id8>`；id8 = `crypto.randomBytes(4).toString("hex")`，展示用前 4 位（对齐 Codex「036b」风格）。名称≠分支名。
- **会话根目录 = worktree 目录**：spawn cwd、CLI 会话库（按目录哈希分库）、Git 面板、tasks-index `workspace_path` 全部是 worktree 路径，绝不回落原项目。
- **根项目 checkout 不被触碰**：新建工作树不 checkout 根工作区。
- 后续需要分支时，用现有 `createBranchAndSwitch` 在 worktree 内建分支（如 `codex/<slug>`）。

## 状态所有者（单一写入路径）

| 状态                                             | 所有者                                                                | 说明                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| worktree 注册表（`~/.mikiko/v2/worktrees.json`） | host 内 **WorktreeService**（唯一写入者，串行队列 + atomicWriteText） | 磁盘 git 真值以 `git worktree list` 对账：注册在但磁盘消失 → 标记 `missing`，列表页提示清理 |
| worktree 配置（根目录/fetch/自动清理）           | `AppSettings.worktreeConfig`（settingService 落盘）                   | WorktreeService 每次操作时现读，无缓存失效问题                                              |
| worktree 目录生命周期                            | git 本身（`.git/worktrees/<id>`）                                     | 删除 = `git worktree remove [--force]` + `prune` + 注册表移除                               |
| 渲染层注册表视图                                 | `useWorktreeRegistryStore`（zustand 只读缓存）                        | 加载点：App 挂载、设置页打开、创建/删除 RPC 返回后、聚焦刷新；不作为真值                    |
| 草稿工作位置                                     | `draftWorkLocationStore`（zustand，按根 workspaceKey）                | 值：`{ mode: "local" \| "new-worktree" \| "existing-worktree", ref?, worktreePath? }`       |
| 会话/任务数据                                    | 既有链路（CLI 会话库 → sessions-index → tasks-index）                 | worktree 会话的 workspace_key = worktree 路径，**不做任何键改写**                           |

## 接口

### ServiceChannels.Worktree（host，注册于 createLocalServices）

```ts
interface IWorktreeService {
  list(): Promise<WorktreeListItem[]>; // 按根项目分组：entry + gitStatus 摘要 + 关联会话(TaskMeta 摘要)
  create(input: { rootWorkspacePath: string; ref?: string }): Promise<WorktreeRegistryEntry>; // 含自动清理
  remove(input: { worktreePath: string; force?: boolean }): Promise<WorktreeRemoveResult>;
  touch(input: { worktreePath: string }): Promise<void>; // 更新 lastUsedAt（会话创建/激活时调用）
}
```

- 服务实现位于 `packages/services/src/git/worktreeService.ts`；git plumbing 进 `gitCliRepo`（list/add/remove/prune/远程默认分支）；注册表 IO 在 `worktreeRegistry.ts`。
- **不做 SSH 远程 workspace 接入**：不加入 `remoteWorkspaceServiceCollection` 与 `legacyRemoteWorkspaceRpcContract`（旧端缺 channel 会硬抛错）；手机经本地 attachment 天然可达（attachment 暴露 createLocalServices 全量）。
- accessor `worktreeService` 为**可选字段**（旧 wire 容忍缺失）；UI 以服务是否存在决定设置分区渲染。

### AppSettings 扩展（additive，免迁移）

```ts
worktreeConfig?: {
  rootDir: string;              // 默认 ~/.mikiko/worktrees
  fetchBeforeCreate: boolean;   // 默认 true
  autoPruneEnabled: boolean;    // 默认 false
  autoPruneLimit: number;       // 默认 5，1–50
}
```

zod 同步加进 `validationAppSettings.ts` 的 object 与 patch 两个 schema（externalCdpConfig 先例）。

### 关联会话查询

设置页每行的「关联会话」= `taskIndexRepo` 按 `workspace_path == worktreePath` 精确查询（同进程直查，无新 RPC 面）。

## 事件顺序

### 创建工作树会话（核心链路）

```text
用户在草稿选「新建本地工作树」(+起始分支)
  → prewarm 被门禁停用（工作位置≠local 时 useDraftSessionPrewarm 不注册；已预热则丢弃 draft sessionId）
  → 首条消息发送（幂等键：本窗口草稿，创建期间 composer 锁定「正在创建工作树…」）
  → RPC worktreeService.create
      → [可选] git fetch --prune <remote>
      → 解析 ref（缺省=远程默认分支）
      → git worktree add --detach <dir> <ref>
      → 注册表写入（串行）
      → 自动清理检查（见下）
  → 成功：ensureWorkspaceTab(worktreePath) + startDraft(worktreePath) + 首条文本经 initialPrompt 通道投递
  → createSession(workspaceId=worktreeKey)（既有 v4 命令，零协议改动）
  → 失败：composer 顶部错误条（本地化标题 + git 原始信息进详情，附「改用本地模式」一键切换），草稿与文本保留
```

### 删除（手动，D1：连同会话历史）

```text
设置页「删除」→ 确认框（列明关联会话数 + 脏文件数）
  → 资格校验：worktree 无存活 CLI 进程（processManager）→ 否则阻止并提示先关闭会话
  → git worktree remove（干净树）/ 二次确认后 remove --force（脏树）
  → git worktree prune + 注册表移除 + 删除该 workspace 全部 task 行（含分组成员关系）
  → 广播 workspace_task_list_changed（既有机制自动触发列表刷新）
```

### 自动清理（D2：按根项目；D4 资格）

```text
create 成功后：同根项目注册条目按 lastUsedAt 升序
  while (数量 > autoPruneLimit):
    candidate = 最旧
    资格 = 无存活进程 && git status 干净 && 无 pinned/未读 task
    不合格 → break（warn 日志）；合格 → 删除（同手动链路）后继续
```

## 失败语义

- create 失败（非 git 仓库 / git 不可用 / ref 不存在 / 目录已存在）：不写注册表、不建 tab、草稿保留、错误条展示 git 原始信息；host 侧 `log.error` 落盘（含根项目路径），供回查。git 可执行文件缺失与非仓库两种原因分开报错文案。
- **首发分流失败必须落到 composer 错误横幅**（2026-10-09 修复：`maybeRedirectWorktreeFirstSend` 曾在 `handleSendText` 的 try/catch 之外调用，错误横幅设置点永远不触发，叠加 renderer 生产日志 no-op，用户只看到发送按钮转圈后恢复、零反馈）：pane-local `sendSubmissionError`（code `WORKTREE_FIRST_SEND_FAILED`，标题本地化、git 原始错误进 detail），草稿与文本由 composer 原路径保留。横幅提供「改用本地模式」一键动作：把该根项目草稿工作位置切回 `local` 并关闭横幅，**不自动重发**（用户明确要求隔离环境时静默降级到主工作区有风险，重发由用户手动触发）。
- fetch 失败（离线等）：**warn 后按本地已有 ref 继续创建**，不阻塞（离线友好；实际起点 ref 与短 SHA 在列表展示）。
- 注册表损坏：隔离损坏文件（`.corrupt-<ts>`）后从空表启动（settingService 同款策略）；`git worktree list` 对账时可发现磁盘孤儿（v1 只提示不强收）。
- 删除时进程存活：直接拒绝（不提供 kill 选项，避免误杀运行中会话）。
- 多窗口并发写注册表：host 内单写入者串行队列兜底；渲染层缓存以「读时可能滞后」为代价（下次加载点收敛）。

## 平台与远控边界

- 桌面渲染进程 + 手机远控（本地 attachment）：完整功能。
- SSH/远程 workspace：设置分区不渲染（服务不在远程集合）、草稿不出现工作位置选项（workspace 非本地）。
- Web（非远控）：服务可达则分区渲染（服务器本机仓库），不可达则隐藏——UI 以 `worktreeService` 存在性门控。
- Windows：路径统一 `path.resolve`；目录名长度受控（hash4+id8）；验收含 Windows 实测。
- **rootDir 的 `~` 展开必须同时识别 `~/` 与 `~\`**（2026-10-09 修复）：默认值 `~/.mikiko/worktrees` 是正斜杠写法，而 win32 的 `path.sep` 是 `\`，此前按 `~+sep` 匹配不到，路径被当相对路径解析到 host 进程 CWD（打包后通常为 Program Files，不可写）→ `git worktree add` 必败且被 UI 吞掉（v1.0.7 Windows「新建本地工作树」静默失败根因）。

## 侧栏并入（D3）与展示

- **原则：task 实体键 = worktree 真实 workspaceKey 不变**（缓存、乐观变更、路由全部正确）；只在查询 scope 扩宽 + 展示分组层并入。
- 项目视图：根项目行的查询 `workspaceScopes` 追加其注册 worktree 的 scope；`WorkspaceSidebar` 组装时把 worktree 组合并进根组（items 合并、hasUnread/workflowCount OR 合并）；行点击/重命名/置顶等按 task 自带 workspacePath 路由。
- timeline/pinned/自定义分组视图：经 scope 扩宽自动包含 worktree 会话。
- 徽标：`TaskListItem`/`GroupedTaskRow` leading slot 显示 `GitBranch` icon（注册表命中该 task 的 workspacePath）；hover 让位给 pin 按钮（复用现有互斥）。
- 显示名：worktree workspace 展示「repoName · 短id」（注册表派生），作用于侧栏项目行、分组视图行标签、空态项目菜单。

## `/new` 命令

- 注册进 `appSlashCommands`（`/side` 同构；会话态可用，草稿态不提供——草稿本就是新建页）。
- 本地会话：`startDraft(当前根项目)` + 工作位置=local；分支预选**当前 workspace 分支**（v1 未记录每会话的创建时分支；「按会话起点分支预选」列为后续增强，需 task meta 写通道）。
- worktree 会话：`startDraft(当前 worktree)` + 工作位置锁「现有工作树 · 短id」、分支锁「分离头指针」（均不可交互）。

## 验收场景

1. 非仓库/远程 workspace 草稿：不出现「新建本地工作树」选项或禁用态+提示。
2. 选起始分支 feature/x 创建：目录 `<rootDir>/<repo>-<hash4>/<id8>` 存在、detached、HEAD==feature/x 顶端；fetch 开启时创建前发生 `git fetch --prune`。
3. 会话内改动/提交只影响 worktree；根项目 `git status` 不变；状态栏显示「分离头指针」。
4. `createBranchAndSwitch` 建 `codex/foo` 后状态栏显示分支名。
5. 设置页：分组/关联会话/刷新正确；「在此工作树中新建聊天」直接落到该 worktree 草稿。
6. 删除：运行中阻止；干净树确认后目录+注册表+task 行全清；脏树需 force 二次确认；会话从侧栏消失。
7. 自动清理：按根项目计数、只删合格最旧项（D4），不合格跳过并 warn。
8. `/new`：本地会话预选原分支；worktree 会话锁定两 chip。
9. 侧栏：worktree 会话出现在根项目组、带分支 icon、hover 显示 pin；置顶/未读计数正确（双桶去重不受影响）。
10. 手机远控：设置 → Worktrees 可见可操作（本地 attachment）。
11. 首发分流失败（拔掉 git / 目录不可写模拟）：错误横幅出现（标题本地化、detail 含 git 原始 stderr），「改用本地模式」点击后工作位置 chip 切回本地、横幅关闭、草稿保留；再次发送走本地模式成功。
12. `rootDir` 写 `~/.mikiko/worktrees`（正斜杠）与 `~\.mikiko\worktrees`（反斜杠）时，worktree 目录都落在用户主目录下而非进程 CWD。
13. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过；新增单测（目录派生、注册表对账、清理资格、settings schema）全绿。
