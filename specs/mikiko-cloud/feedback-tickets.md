# Bug 问题上报与工单管理（feedback tickets）

> 2026-10-19 立项。桌面端 Bug 上报从智谱官方接口切换到 mikiko-cloud 自建
> （agent.mikiko.ai），并新增管理后台工单流程。取代
> `agent-endpoint-plan.md` §4.4「反馈关闭」决策。

## 1. 客户端（本地优先）

- **出网仅 `agent.mikiko.ai`**：`resolveMikikoFeedbackApiBase()`（shared
  zcodeEndpoint，默认 `https://agent.mikiko.ai/api/v1`，`MIKIKO_FEEDBACK_API_BASE`
  支持 `disabled` 语义并已入 `pickProductEndpointEnv` 白名单）。旧
  `feedbackHttpClient`（z.ai 协议 + OSS 直传 + JWT）已删除。
- **鉴权：设备 token**。`sha256(deviceMid)` 经
  `/api/v1/shares/device/register` 注册换 token（与分享共用注册端点、独立凭据键
  `mikiko-feedback:device-token`）；401 清缓存重注册重试一次。不再使用智谱 JWT。
- **本地优先**：创建成功无条件写 `~/.mikiko/feedback/tickets.json`
  （additive `syncState: synced` + `description`）；云端 5xx/网络失败时写
  `pending-sync` 记录后向 UI 抛真实错误。「我的反馈」一律读本地（换设备不同步）；
  `get` 走本地记录；`comment` 抛不支持（待 OAuth）。
- **OAuth 迁移预留**：`FeedbackAccountSync`（feedbackService.ts，空实现）。
  接入统一 OAuth 后：上报记录补 `userId`；实现
  `syncPendingLocalRecords()` 把本地记录按 `clientTicketId` 对账迁移到远端账号。
- **入口重开**：`FEEDBACK_ENTRY_ENABLED = true` + 帮助菜单「问题上报」项放回
  （desktopApplicationMenu）。表单/截图/日志开关 UI 与日志归档
  （mikiko-diagnostic-logs.zip、32MB 预算、redactFeedbackText 脱敏）不变。

## 2. 服务端（mikiko-cloud）

内部边界（2026-10-20）：`feedback.ts` 保留客户端设备/账号路由与原有公开导出；
`feedbackAdmin.ts` 只处理 Worker 完成 admin session 鉴权后转入的管理路由；
`feedbackModel.ts` 集中 D1 行映射、枚举、响应信封与共用单行读取，双方不保存第二份业务状态。
拆分不改变 HTTP 路径、鉴权顺序、D1/R2 操作、错误码与导入幂等规则；同一套客户端、管理端和账号回归在拆前/拆后执行。

- **存储**：D1（`DB`，database `mikiko-cloud-db`，migrations/0001 三表：
  `feedback_tickets` / `feedback_attachments` / `feedback_comments`）+ R2
  （`FEEDBACK_ARTIFACTS`，bucket `mikiko-feedback-artifacts`，对象
  `feedback/{ticketId}/{attachmentId}`）。
- **客户端端点**（设备 token + IP 分钟桶限流：创建 5/min、附件 20/min）：
  - `POST /api/v1/feedback/tickets`：JSON 创建；字段上限 title 200 /
    description 8000 / contact 200 / environment 16KB；默认
    `status=pending_triage`。
  - `POST /api/v1/feedback/tickets/{id}/attachments`：二进制 Worker 中转到 R2；
    zip ≤40MB、截图（png/jpeg/webp）≤10MB、每工单 ≤6 个。
- **管理端点**（admin session cookie；worker.ts admin 门禁后转 feedback.ts）：
  列表（status/type/关键词过滤 + 分页）、详情（工单+评论+附件）、PATCH
  （status/type/fix_version/assignee）、评论增/改/删（任意阶段）、附件下载。
- **管理页**：`public/admin.html` 新增「问题反馈工单」视图（列表过滤分页 +
  详情抽屉 + 评论线程 + 附件下载链接），沿用既有 vanilla JS/登录态。

## 3. 枚举（存机器码，UI 显中文）

- 状态：`pending_triage` 待定位（默认）→ `triaging` 定位中 / `located` 已定位 /
  `not_issue` 非问题 / `awaiting_release` 待出包 / `resolved` 已解决。
- 类型：`legacy_bug` 历史Bug / `new_regression` 新引入缺陷 / `config_issue`
  配置问题 / `product_misunderstanding` 产品理解问题 / `env_data_anomaly`
  环境数据异常 / `product_design` 产品设计问题 / `other` 其他（上报时为空，
  由跟进人归类）。
- 评论：`author`（跟进人署名）+ `body`（根因/过程/修复方案/发布备注），
  任意阶段可增删改（更新时间戳保留编辑痕迹）。

## 4. 测试与部署

- 测试：mikiko-cloud `node --test`（内存 KV/R2 + `node:sqlite` 实现的 D1 shim
  跑真 SQL，test/helpers.ts）；services 侧 mock fetch（privacy boundary +
  401 自愈）。
- 部署（2026-10-19 已完成首次上线）：
  - 一次性初始化：`wrangler d1 create mikiko-cloud-db`（id 已回填
    wrangler.toml）→ `wrangler d1 migrations apply mikiko-cloud-db --remote`
    → `wrangler r2 bucket create mikiko-feedback-artifacts`。
  - 日常部署：GitHub Actions
    `.github/workflows/deploy-mikiko-cloud.yml`（v\* tag / 手动 dispatch；
    含 D1 迁移；需 `CLOUDFLARE_API_TOKEN`，未配置时跳过）。

## 5. 安全备注

`.admin-credentials.local` 曾被 git 追踪（含真实管理凭据）——已 `git rm
--cached` + gitignore（条目本已存在）；**凭据已在 git 历史中，必须轮换
MIKIKO_ADMIN_USERNAME/PASSWORD**。

## 账户化与产品需求模块（2026-10-20 批次 3）

### kind 字段

- `feedback_tickets.kind`：`"bug"`（默认）| `"feature"`（给产品提需求，Part C-b）。客户端 `ticketType === "feature"` 时发送 `kind: "feature"`。

### 账号归属（owner_sub / owner_email）

- Mikiko ID（KeyCloak）sub 为账号唯一键（不建用户表）。创建工单时可选 Bearer（`oidcTokenVerify.ts` 手写 WebCrypto JWKS RS256 验签，`azp ∈ {mikiko_code}`）；携带 Bearer 但验签失败 → **fail-close 401，不降匿名**。

### 账号端点

- `GET /api/v1/feedback/tickets/mine`：本人工单分页。
- `GET /api/v1/feedback/tickets/{id}`：本人工单详情（403 非本人）。
- `POST /api/v1/feedback/tickets/{id}/comments`：本人追加评论。
- `POST /api/v1/feedback/tickets/migrate`：本地历史工单幂等迁移——先按 `client_ticket_id` 认领匿名行（UPDATE，不重复 INSERT），缺失才补建。

### 客户端

- 登录态创建走账号通道（Bearer + kind），未登录回落设备 token（匿名）。
- 登录态「我的反馈」读远端 mine；失败回落本地。
- `syncAccountRecords`：Mikiko ID 登录事件后自动迁移本地档案（含 pending-sync）并整体清档。

### 管理后台

- admin SPA（`/admin/`，Vite + React + Tailwind）四分区：问题反馈工单 / 产品需求（kind=feature 过滤）/ 模型预设配置（表单 + JSON 双模式）/ 功能配置。
- 工单列表操作列（状态下拉直改 / 删除 / 详情）+ 详情抽屉两栏（截图灯箱预览 + 评论时间轴）。
- 「提交漏洞」菜单已彻底移除（Part C.2.a）。
