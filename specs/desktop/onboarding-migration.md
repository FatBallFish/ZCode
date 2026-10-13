# 引导/设置迁移：Claude Code 与 Codex CLI 原生历史导入

> 2026-10-11 定稿（Codex 支持新增；Claude Code 导入为既有能力，此处一并收口）。
> 客户反馈：期望引导流程的迁移数据步骤支持 Codex 项目导入及其历史会话迁移。

## 范围与来源

| 来源        | 扫描目录                                                            | 解析文件                                         | migrationSource |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------ | --------------- |
| Claude Code | `~/.claude/projects/**/*.jsonl`（HOME 候选 + MIKIKO_DATA_BASE_DIR） | 每文件全量 jsonl                                 | `claudeCode`    |
| Codex CLI   | `CODEX_HOME/sessions`（env 优先）∪ `~/.codex/sessions/**/*.jsonl`   | rollout jsonl（每行 `{timestamp,type,payload}`） | `codex`         |

Codex 路径自适应：`CODEX_HOME` 环境变量优先（Codex CLI 官方语义），否则各 home 候选
（`homedir()`、`$HOME`，Windows 下 `homedir()` 解析 `%USERPROFILE%`）下的 `.codex/sessions`。

## 管线（两来源同构）

```text
repo 扫描（head 解析：cwd/标题/时间）
  → UI 候选（ZCodeImportableSessionCandidate.provider = claude|codex，按 workspace 分组）
  → 选中导入：find candidate → 校验 workspace 目录存在 → 复制 jsonl 副本
     （agent-config/claude|codex/{workspaceHash}/…，互不混写）
  → parser 提取「可见消息」（仅用户真正可见的 user/assistant 文本）
  → zcodeAgentService.createSession({importedHistory:{source:"claudeCode"|"codex", messages}})
  → CLI persistImportedSessionHistory 落 session store（metadata.migrationSource=source）
  → 写最小 task snapshot + tasks-index syncTaskMeta（migrationSource 同步）
```

- Codex 可见消息规则：只取 `response_item.payload.type="message"` 的 user/assistant 文本
  （input_text/output_text）；`event_msg`（重复播报）、reasoning、function_call 全部忽略；
  SDK 注入的 `<user_instructions>`/`<environment_context>`/`<turn_context>` 等整段标签块
  剔除。assistant 多条流式拆条按「下一轮 user 或文件结束」聚合成单条。
- 时间戳：优先行级 `timestamp`；createdAt 取首条可见 user 消息时间，session_meta 兜底。
- model 取 `turn_context.payload.model` 最后出现值；不落运行态 mode（固定 build）。
- 导入 taskId：`codex-import-{sha256("codex:"+workspacePath+":"+sessionId)[:24]}`（确定性，
  重复导入幂等覆盖）；重导入前 CLI 按 metadata.migrationSource 清旧消息。
- **注入过滤扩展（2026-10-12/13）**：除整段 `<tag>` 包裹（tag 集合补 `user_action`）外，
  还按前缀/跨段状态机剔除：`# AGENTS.md instructions for …`、`# Files mentioned by the
  user:`（含 `## <文件名>: /绝对路径` 附件续段）、`# Chrome tabs:`、`# Context from my IDE
  setup:`、`# PR Review System Prompt`、`<codex_internal_context …>`、
  `<in-app-browser-context …>`、含 `<INSTRUCTIONS>…</INSTRUCTIONS>` 块的模板注入。块型
  注入内部含空行、按空行切段后续段无标记——用跨段状态机（块开→闭合前的续段全部丢弃）
  处理；**不做整条消息判定**（Codex 会把注入块与真实输入拼在同一条 user 消息里，整条
  丢弃会吞掉真实输入，本机语料 376/400 的真实输入与注入同条）。本机 400 文件采样：注入
  噪声标题从 ~90% 降到 4%（余下多为用户自有工作流模板正文，语义上即任务内容）。
  Codex 正式线程名（threads 表 title）多为首条 user 消息派生，过滤修正后标题与 Codex
  侧一致；用户手动改名的线程名存于 `~/.codex/state_5.sqlite`，引入 sqlite 读取的跨平台
  成本过高，不做。
- **归档过滤（2026-10-12）**：扫描显式跳过 `archived_sessions/` 目录（Codex 归档线程的
  rollout 会被移入该目录；个别版本残留时也按目录名排除）。
- **会话级幂等（2026-10-12）**：导入前按确定性 taskId 查 tasks-index；已存在且
  `meta.updatedAt - 源文件 mtime > 5min`（松弛量）判定为「已在 App 内延续/改名」→ 整体跳过
  （skipped reason=`session_continued_in_app`）；否则重导入——CLI 消息级清理保留续聊内容、
  重写导入消息与标题，即「已导入异常会话的自动修复」。
- **「每句话一个任务」复核结论（2026-10-12）**：导入器严格 1 rollout 文件 = 1 会话 = 1 任务，
  不按消息/时间切分；任务数量多源于 Codex CLI 为每个线程/每次 `codex exec` 各写一个 rollout
  文件（本机实测 ~/.codex/sessions 下 3000+ 文件）。非导入器缺陷，不做静默合并/丢弃。

## 协议与类型

- `ZCodeImportSessionSourceProvider = "claude" | "codex"`；`ZCodeTaskMigrationSource =
"claudeCode" | "codex"`（zod enum 同步）。
- `zcodeSessionImportHistorySchema` 新增 `source:"codex"` variant（消息结构与 claudeCode
  相同；单独 variant 保留来源归属，持久化层按 source 写 metadata.migrationSource）。
- 服务接口新增 `scanImportableCodexSessions` / `importCodexSessions`（与 Claude 方法同构）。

## UI（引导向导 + 设置迁移页共用 useClaudeSessionMigration）

- 职业引导的「迁移会话数据」选项副标题（`occupationOnboarding.migrationDescription`）需同时
  提及两个来源（Claude Code 与 Codex CLI），不能只写 Claude。
- 扫描：Claude 与 Codex 并行扫描合并（按 updatedAt 排序）；Codex 扫描失败（如旧 host 进程
  无该方法）降级为仅 Claude 并记 warn，不阻断向导；Claude 扫描失败才展示 scanError。
- 导入：按候选 provider 拆分 sessionIds 分别调用两个导入服务，结果合并；单来源失败记
  importError 但保留另一来源的部分成功结果。
- 工作区卡片展示总数徽标；含 Codex 记录时附「Claude Code n · Codex m」来源分布。
- **数量上限（2026-10-12）**：设置迁移页增加「不限数量（扫描全部）」开关（复用 onboarding 的
  `UNLIMITED_SCAN_LIMIT_INPUT` 语义，扫描不传 limit）；数字输入框（1–500）保留为默认路径。
  此前设置页只能填数字、清空输入静默回退 100，用户「选了不限仍只有 100 条」的反馈即源于此。

## 验收

1. 本机存在 `~/.codex/sessions/**/rollout-*.jsonl`（或 CODEX_HOME）时，迁移步骤扫描出现
   对应项目分组与计数；不含注入标签的会话正文。
2. 选中导入后：任务出现在对应 workspace 任务列表（migrationSource=codex），可在会话中
   继续对话；原始 rollout 不被修改（导入写副本）。
3. workspace 目录不存在的候选导入时 skipped（workspace_path_missing），不产生半成品任务。
4. 无可见消息的 rollout 扫描跳过/导入失败并计入 failed，不中断其余导入。
5. Claude 导入行为回归不变（provider 拆分后两端各自幂等）。
