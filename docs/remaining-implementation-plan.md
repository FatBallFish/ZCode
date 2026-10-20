# Mikiko ID 对接——未完成项实现方案与执行计划

> 来源：`docs/mikiko-id-integration-plan.md` 全量交叉比对后确定的 18 个未实现项。
> 本文件是唯一的执行跟踪文档，按此顺序逐项完成。

## 代码实现（可立即做）

### 1. 模型预设配置表单编辑器 React 化（方案 D.3）
- **现状**：admin SPA 的模型预设配置只有 JSON 模式 + 发布/历史/恢复 + 分区计数，无表单编辑。
- **改动**：`packages/mikiko-cloud/admin/src/pages/ModelConfig.tsx` 增加 modelRules / modelApiRules / providerSiteRules 三个分区的可视化卡片列表（每条规则一张卡片，支持增/删/编辑关键字段），未覆盖分区仍走 JSON 模式。
- **验收**：React 组件能渲染现有配置的规则卡片、编辑后可发布。

### 2. admin SPA Vitest 组件冒烟（方案 D.7）
- **改动**：`packages/mikiko-cloud/admin/src/pages/__tests__/` 添加 Tickets / Login / AdminLayout 冒烟测试。
- **验收**：`pnpm --filter @zcode/mikiko-cloud-admin test` 全绿。

### 3. admin SPA 生产部署（方案 D.7）
- **改动**：`cd packages/mikiko-cloud && npx vite build --config admin/vite.config.ts && npx wrangler deploy`。旧 `/admin.html` 保留。
- **验收**：`https://agent.mikiko.ai/admin/` 可访问。

### 4+5. 桌面 main→host IPC 桥 + re-claim（方案 E.4）
- **现状**：`wiring.ts` 的 `getMikikoIdAccessToken` 选项已声明但未传入。
- **改动**：在 `node.ts`（host 侧）订阅 `sub2ApiService.onOIDCLoginCompleted` 和 `onDidChange`，直接从 host 进程调 relay HTTP `/api/rc/devices/claim`（host 有网络 + 可读 userData 下的 `remote-control-device.json` 获取 mid）。
- **备选**：新增 main↔host IPC channel（PlatformChannels + preload bridge）。
- **采用**：host 侧直接 HTTP 调用，避免新增 IPC channel——host 已有网络能力，mid 从 userData 文件读取。
- **验收**：MikikoCC OIDC 登录后远控设备自动认领。

### 6. KeyCloak 创建 `mikiko_remote` client
- **改动**：通过 admin REST API 创建 Public client，redirect URI `https://remote.mikiko.ai/remote/devices/callback`。
- **验收**：remote.mikiko.ai 登录跳转到 KeyCloak 授权页。

### 7. relay 生产部署
- **改动**：SSH 到 VPS，更新 `/srv/mikiko-remote/relay.env` 加 `RELAY_OIDC_ISSUER=https://oauth.mikiko.ai/realms/mikiko`，重新构建 `relay.cjs`，重启 `mikiko-relay` systemd。
- **验收**：`https://ws.mikiko.ai/api/rc/account/devices` 带 Bearer 返回 200。

### 8. web remote-control 生产部署
- **改动**：`pnpm build:web-remote-control` 并上传到 Cloudflare Pages（或 `wrangler pages deploy`）。
- **验收**：`https://remote.mikiko.ai/remote/devices` 可访问。

### 9. `/healthz` 增加 `accountApi: 1` 能力位（方案 E.3.5）
- **改动**：`packages/relay-server/src/server.ts` healthz 响应追加 `accountApi: 1`。
- **验收**：healthz JSON 含该字段。

### 10. CORS 收敛（方案 E.3.4）
- **改动**：`/api/rc/account/*` 端点的 `Access-Control-Allow-Origin` 从 `*` 收敛为 `https://remote.mikiko.ai`。
- **验收**：非 remote.mikiko.ai origin 的预检请求被拒。

### 11. spec §23 账号直连（方案 E.3.6）
- **改动**：`specs/remote/mobile-remote-control.md` 追加 §23 章节。
- **内容**：信任模型（本人账号即本人设备）、双轨并存（HMAC 票据 + OIDC 直连）、内存绑定语义（relay 重启 re-claim）。

### 12. 「我的反馈」模式指示（方案 F.2.2）
- **改动**：`packages/ui/src/feedback/TicketsView.tsx` 顶部区分「已同步到 Mikiko 账号」vs「本地记录」。
- **验收**：登录态显示远端指示。

### 13. 反馈同步流 E2E（方案 F.3）
- **改动**：`packages/desktop/test/e2e/feedback-account-sync.test.ts`。

### 14. 已编写 E2E 用例执行
- **现状**：`mikikocc-oidc-login.test.ts` + `onboarding-migration-dialog.test.ts` 从未成功执行。
- **改动**：修复 wdio chromedriver 会话创建（chromedriver-147 已 staging，需要进一步调试 `--app=` 参数与 user-data-dir 时序）。

### 15. B 工作树长名 E2E 用例（方案 B.3）
- **改动**：`packages/desktop/test/e2e/worktree-long-name.test.ts`。

### 16. I 模型列表 E2E 用例（方案 I.3）
- **改动**：合入 `mikikocc-oidc-login.test.ts` 或独立 spec。

### 17. sub2api-gateway spec OIDC 章节（方案 A.8）
- **改动**：`specs/desktop/sub2api-gateway.md` 追加 OIDC 登录方式、事件、logout 语义。

### 18. feedback-tickets spec 更新（方案 C.2.b）
- **改动**：`specs/mikiko-cloud/feedback-tickets.md` 补记 kind 字段与需求模块。
