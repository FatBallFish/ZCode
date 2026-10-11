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

## 验收

1. 本机存在 `~/.codex/sessions/**/rollout-*.jsonl`（或 CODEX_HOME）时，迁移步骤扫描出现
   对应项目分组与计数；不含注入标签的会话正文。
2. 选中导入后：任务出现在对应 workspace 任务列表（migrationSource=codex），可在会话中
   继续对话；原始 rollout 不被修改（导入写副本）。
3. workspace 目录不存在的候选导入时 skipped（workspace_path_missing），不产生半成品任务。
4. 无可见消息的 rollout 扫描跳过/导入失败并计入 failed，不中断其余导入。
5. Claude 导入行为回归不变（provider 拆分后两端各自幂等）。
