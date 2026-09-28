# agent.mikiko.ai 自建端点与接口替换方案（Mikiko Cloud）

> 关联：`specs/update/update-service.md`（agent-update.mikiko.ai 自建升级服务）、`specs/update/update-check.md`。
> 版本基线：v1.0.4（custom_main）。

## 0. 实施状态（2026-09-28，P1–P4 编码与验证完成）

| 阶段            | 状态      | 落点                                                                                                                                                                                                    |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 模型预置配置 | ✅ 已实现 | 客户端 `mikiko-builtin-config-client.ts`（provider-node）+ `mikikoBuiltinRemoteConfig.ts`（services）+ `node.ts` fetchRelease 换源；服务端 `packages/mikiko-cloud`（Worker + /admin 管理页 + 种子脚本） |
| P2 关闭与收窄   | ✅ 已实现 | 遥测硬关（`env.ts`）；反馈隐藏入口（`FEEDBACK_ENTRY_ENABLED` 总开关 + 5 处 UI 入口）；provider envelope 收窄；dynamicWorkflow 迁 `MikikoClientConfigService`（fail-open alwaysOn）                      |
| P3 分享自建     | ✅ 已实现 | Worker `shares.ts`（设备 token + IP 限流 + 四阶段 + 公开读 + R2）；客户端 `mikikoShareDeviceToken.ts` + baseUrl/落地页切换；落地页 `public/share.html`                                                  |
| P4 双读迁移     | ✅ 已实现 | `MIKIKO_BASE_URL`/`MIKIKO_ENDPOINT_ORIGIN`/`MIKIKO_CDN_BASE_URL`/`MIKIKO_UPDATE_FEED_URL` 优先、ZCODE\_ 旧名回退                                                                                        |

实施中的关键事实修正：官方线上 `client/configs` 已停发 `builtin_provider_config_json`（远端规则热更通道事实下线），种子源改用仓库打包 `config/provider/zcode-builtin.json`；`dynamicWorkflow.mode` 取值域为 `disabled/onDemand/alwaysOn`（自建默认 alwaysOn）。

验证结果：services 单测 38/38、mikiko-cloud 单测 18/18、全链路 E2E 6/6（真 HTTP 服务 × 客户端真实实现：发布/预览/续聊/限流/artifact/设备 token）、typecheck（含 mikiko-cloud 包门禁）/lint/fmt/architecture 全绿。独立 code review 完成并已修复全部 Blocker：lockfile 与类型门禁（B1/B2）、分享 disabled 不再回退官方（B3）、补齐 ChatErrorBanner/订阅错误面板/TaskListItem 三个漏网反馈入口（B4）；同时落地 review 建议项：device/register 与 artifacts/confirm 独立限流 + 设备 TTL（S1/S2）、KV 读异常防 revision 回退（S3）、shareWebUrl 统一 resolver（S5）、disabled 场景 fail-open 统一 alwaysOn（S6）、注册失败服务日志（S7 部分）、落地页导入深链（S9）、descriptor/integrity/payload_sha256 服务端校验（S10）、死代码清理（S11 部分）、E2E 改公开入口跨包导入（S12）、登录失败延迟 500ms（S13）、CLI 侧（process-provider-registry-runtime）builtin 下载一并换源。

**版本数据实时化（2026-09-28）**：官网版本信息从写死改为实时。① `GET /api/v1/releases/latest`（`src/releases.ts`）：并发拉 agent-update 三平台 manifest，YAML 解析聚合成 JSON（version/releaseDate/releaseNotesByLocale.zh-CN.markdown/files 按 URL 后缀分类），内存缓存 60s + 边缘缓存 60s，上游失败回退最近一次聚合；三平台版本不一致（发布进行中）拒绝聚合。② 首页 hero 版本号/智能下载按钮、下载页版本文案/三卡片/Linux 规格弹层链接全部运行时取 latest 接口，页面内写死直链降级为接口失败 fallback（`download-detect.js` 的 `MIKIKO_FALLBACK`）。③ 更新日志页全动态：顶部条来自 latest 接口（发布 manifest 即生效，不依赖流水线额外步骤），历史条目来自 `GET /api/v1/releases/notes`（KV `rn:{version}`，按语义版本倒序）；`PUT /api/v1/admin/release-notes`（`X-Publish-Token` 鉴权，secret `MIKIKO_RELEASE_PUBLISH_TOKEN`，同版本幂等覆盖）由发版流水线自动调用——`scripts/publish-update-feed.mjs` 第 3 步用同一份 release notes 推送（env `WEBSITE_PUBLISH_TOKEN`，GitHub secret，未配置仅 warn 跳过）；存量 1.0.0–1.0.4 已种子化入 KV。共享轻量 Markdown 渲染器抽至 `public/markdown.js`（share/changelog 复用）。

**分享落地页与生命周期（2026-09-28）**：落地页渲染对齐应用会话风格（`public/share.html`：用户气泡 / 助手正文轻量 Markdown 渲染（先 escape 再结构替换、链接仅放行 http(s)）/ 工具调用默认折叠为紧凑条（状态点 + 工具名 + 输入摘要，点击展开输入输出，顶部「展开/收起全部」）/ 轮次分隔线 / 统计条；「导入到 Mikiko」复用 site.css 品牌 btn 样式）。数据保留：分享元数据与 rows 走 KV `expirationTtl` 7 天自动删除；R2 `artifacts/` 前缀已配置 lifecycle 规则 `share-artifacts-7d`（7 天过期 + 未完成 multipart 7 天中止），附件不再滞留孤儿。**private 口令门（2026-09-28 实装）**：private 分享发布时服务端自动生成 8 位口令（去混淆字符集），只落 sha256 哈希，并把 `?pwd=` 直接拼进 confirm 返回的 `share_url` 随链接分发——完整链接即口令（客户端零改动）；preview/continuation 校验 `?pwd=`：缺失 403 `password_required`（落地页渲染口令输入框）、错误 403 `password_mismatch`（提示密钥不对）。历史无 `pwdHash` 的 private 记录不校验（向后兼容）。已知边界：客户端按 code 导入时无法携带口令——private 本就禁止导入（3214），不受影响。落地页同日改为亮色主题（独立样式、不引 site.css，与官网暗色区分）。

**下载体验改造（2026-09-28 三次部署）**：新增下载页 `/download`（`public/download.html` + `site.css` 下载页样式段）：三张按操作系统的大 Icon 卡片（macOS / Windows / Linux，自绘线条风 SVG 图标），页面以 `min-height: calc(100vh - nav - footer)` 撑满视口；macOS（通用 dmg）与 Windows（x64 exe）点击卡片直接下载，Linux 点击弹出规格选择层（Ubuntu/Debian→deb、CentOS/RHEL/Fedora→rpm、Arch/Manjaro→zst、通用→AppImage，Esc/遮罩/选择后关闭）；顶部按 UA 检测高亮推荐卡片并显示提示。首页下载组件整体移入下载页，Hero 主按钮改为智能下载（`public/download-detect.js` 共享检测：UA-CH platform 优先、UA 正则回退、移动端排除）——macOS/Windows 直连对应安装包、Linux 直下 AppImage 并显示「全部下载选项」次按钮、无法识别回落跳转 `/download`；版本号与资产 URL 集中在 download-detect.js 的 `MIKIKO_VERSION/MIKIKO_FILES` 常量（发版时与 changelog 同步更新）。跨域直链依赖 agent-dl 对二进制 Content-Type 的浏览器原生下载行为，并附加 `download` 属性兜底。

**站点与管理端增强（2026-09-28 二次部署）**：`agent.mikiko.ai` 官网改版为黑色主调企业级产品站（`public/site.css` + 首页 / 文档 `/docs` / 更新日志 `/changelog` 三页，Workers assets 自动漂亮路径；下载链接取自 agent-dl 真实 v1.0.4 资产），`/admin` 入口已从面向访客的页面移除（仅凭 URL 直达）。管理页「模型预置配置」升级为双模式编辑器：默认表单视图（modelRules / modelApiRules / providerSiteRules 三分区可视化：正则匹配、API 格式、推理档位 chips、上下文窗口、输入格式复选、CEL 映射；新增/复制/删除；其余分区 JSON 编辑）+ 高级 JSON 视图；单一数据源 `state.config` 同步——表单变更即时写回并刷新 JSON 文本，JSON「应用」整体替换并重渲染表单，发布成功后两个视图从服务端重拉，杜绝双份数据漂移；JSON 有未应用修改时发布被拦截并提示。

**部署状态（2026-09-28 已上线）**：3 个 KV namespace（BUILTIN_CONFIG=4d8dea…、CLIENT_CONFIG=b3c11b…、SHARE=507604…）与 R2 bucket `mikiko-share-artifacts` 已创建并回填 wrangler.toml；3 个 secrets 已配置（管理凭据存本地 `packages/mikiko-cloud/.admin-credentials.local`，已 gitignore）；种子 revision=30 已写入生产 KV（注意：wrangler v4 `kv key put` 必须 `--remote`，默认写 local 模拟）；Worker 已部署，agent.mikiko.ai 自定义域已生效。生产验证：healthz / builtin-provider-config(revision 30) / client-configs / admin 登录（错误凭据 401 + 固定延迟） / 分享 capabilities（无 token 401）全通过；真实客户端代码全链路（注册→发布→preview 完整性校验→continuation）打生产域名 ALL OK，样例链接 https://agent.mikiko.ai/cn/share/qrfcehgx84 。

## 1. 背景与目标

应用内有多族接口依赖 zcode 官方端点（zcode.z.ai / api.z.ai / chat.z.ai / cdn-zcode.z.ai）。本方案将其中**可自管的部分**迁移到自建 Cloudflare 服务，同时完整保留 Zai 账户与 CodingPlan 链路：

1. Zai 登录、Token 兑换、CodingPlan 查询/重置、Message 网关、用量查询：**不动**，继续走官方。
2. 官方 `client/configs`：**继续调度但收窄取数**（仅 Zai/CodingPlan 相关字段）；功能灰度与分享限流迁到自建 `client/configs`。
3. 模型预置配置（内置规则）：**自建接口 + 管理页**，上线前从官方拉原始数据初始化。
4. 对话分享：**彻底移除官方实现，自建**（设备级 token + IP 限流）。
5. 用户反馈、遥测上报：**关闭**。
6. 新增环境变量一律 `MIKIKO_` 前缀，新增类名用 `Mikiko` 前缀；存量 `ZCODE_` 运维变量按双读方式渐进迁移。

## 2. 官方接口处置总表

### 2.1 保留不动（Zai 账户 / CodingPlan / Message / 用量）

| 接口                                                                                    | 域名             | 用途                                      |
| --------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| `/api/oauth/authorize`、`/api/oauth/userinfo`                                           | chat.z.ai        | Zai OAuth                                 |
| `/api/v1/oauth/token`、`/oauth/cli/init`、`/oauth/cli/poll/{id}`                        | zcode.z.ai       | token 兑换、CLI 设备流登录                |
| `/api/v1/zcode-plan`(+`/anthropic`)、`/billing/current`、`/billing/balance`             | zcode.z.ai       | CodingPlan 网关与计费                     |
| `/api/v1/mcp/usage`、`/api/v1/coding-plan/reset/*`                                      | zcode.z.ai       | 用量与额度重置                            |
| `/api/auth/z/login`、`/api/anthropic/v1/messages`、`/api/monitor/usage/*`、`/api/biz/*` | api.z.ai         | 业务登录、海外网关、用量、购买            |
| `/api/anthropic/v1/messages`、`/coding-plan/*`、`/api/biz/*`                            | open.bigmodel.cn | 国内网关与管理页                          |
| `marketplace.json`、`/official-plugin/assets`                                           | cdn-zcode.z.ai   | 插件市场（本期保留官方，自建规划见 §4.6） |

前提：`ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` 保持官方默认（这是以上接口地址解析的来源，整体切换会破坏 Zai 链路）。

### 2.2 收窄消费：官方 `/api/v1/client/configs`

调用点不带鉴权（GET + `app_version`/`platform`，1h 快照缓存，`bigmodelCodingPlanSubscriptionProvider.ts:599`），继续请求官方。

| 字段                                                                             | 处置       | 去向                                                                                                            |
| -------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `codingPlanStaticProducts` / `codingPlanStaticTeamProducts` / `startPlanPreview` | 继续取     | 套餐列表、StartPlan 卡片                                                                                        |
| `offPeak.enable_offpeak_task`                                                    | 继续取     | 闲时任务总开关（Automations 的闲时排队/执行依赖 CodingPlan off-peak 网关，属 Zai/CodingPlan 数据）              |
| `dynamicWorkflow.mode`                                                           | **停止取** | 迁到自建 `client/configs`（§4.1）；「工作流」标签入口必须保留，控制权收到自建                                   |
| `builtin_provider_config_json`                                                   | **停止取** | 迁到自建模型预置接口（§4.2）                                                                                    |
| `forceUpdate`                                                                    | 停止取     | 无实际消费方：桌面强更 gate 已固定走 `agent-update.mikiko.ai/api/v1/client/configs`（`forceUpdateGuard.ts:47`） |
| `modelContextBudget`                                                             | 停止取     | 3.12.2 起客户端已不消费                                                                                         |

### 2.3 关闭

- **用户反馈**：titleBar 帮助菜单「问题上报」入口 + feedback center 界面 + `node.ts:2594` 的 `createFeedbackService` 装配；`/api/v1/feedback/*` 三族接口不再出网。
- **遥测**：`ZCODE_TELEMETRY_REPORT_ENDPOINT` 默认空 = 已不上报；硬保证改 `packages/shared/src/env.ts:58` `ZCODE_TELEMETRY_ENABLED = false`。

### 2.4 移除并自建替换

- **对话分享**（§4.3）：官方 `zcode.z.ai/api/v1/shares/*` 与 `/cn/share` 落地页全部移除，统一走 `agent.mikiko.ai`。

## 3. 架构（全 Cloudflare）

```
App(Desktop/CLI)
  ├─ 官方 client/configs(zcode.z.ai)      ← 仅 Zai/CodingPlan 字段（§2.2）
  ├─ Zai/CodingPlan/网关 全家族            ← 官方直连，不动（§2.1）
  ├─ GET agent.mikiko.ai/api/v1/client/configs            ← 自建功能配置（dynamicWorkflow、share 限流）
  ├─ GET agent.mikiko.ai/api/v1/builtin-provider-config   ← 模型预置规则（revision 热更）
  ├─ agent.mikiko.ai/api/v1/shares/*                      ← 自建对话分享
  ├─ agent.mikiko.ai/                                     ← 应用主页（介绍+下载）
  ├─ agent.mikiko.ai/admin                                ← 预置配置管理页（账密鉴权）
  ├─ agent-update.mikiko.ai                               ← 既有：更新 manifest + 强更（不改）
  └─ agent-dl.mikiko.ai                                   ← 既有：安装包/附件 R2 下载（不改）
                ↑ Cloudflare Worker(agent.mikiko.ai) ← KV(配置/分享元数据) + R2(分享 artifacts)
```

- 形态：单 Worker + Static Assets（`wrangler.jsonc`：`assets.directory` + `run_worker_first: ["/api/*", "/admin/*"]`），`wrangler deploy` 本地构建直传（避免 Pages git 集成的不可控性）。
- 职责边界：agent-update 只管更新（强更/manifest），agent.mikiko.ai 管功能配置、预置规则、分享、主页。
- 安装包下载继续走 R2 + agent-dl（Worker 不代理大文件）。

## 4. 专题方案

### 4.1 client/configs 双源拆分

**官方源**（收窄）：仅消费 §2.2 表中「继续取」字段；`ZCodeClientConfigEnvelope`（`bigmodelCodingPlanSubscriptionProvider.ts:98-126`）同步收窄类型，删除 `builtin_provider_config_json` / `forceUpdate` / `dynamicWorkflow` / `modelContextBudget` 字段。

**自建源**（新增，`GET agent.mikiko.ai/api/v1/client/configs`）：

```json
{
  "code": 0,
  "data": {
    "configs": {
      "dynamicWorkflow": { "mode": "alwaysOn" },
      "share": { "publishPerMinutePerIp": 3 }
    }
  }
}
```

`dynamicWorkflow.mode` 取值域为 `disabled | onDemand | alwaysOn`（shared 的 `DYNAMIC_WORKFLOW_MODES`），默认 `alwaysOn`。

- `dynamicWorkflow.mode` 取值域沿用 `normalizeDynamicWorkflowMode`（`packages/shared/src/dynamic-workflow-feature.ts`）；「工作流」标签入口依据此值（`AutomationsSection.tsx:604` 灰度未命中即无标签）。**默认 `enabled`**（fail-open，自建接口异常不得关掉功能入口）。
- `share.publishPerMinutePerIp` 仅为客户端体验层（发布前提示），强制限流在服务端（§4.3）。
- 客户端改动：`getDynamicWorkflowClientConfig`（`bigmodelCodingPlanSubscriptionProvider.ts:239-266`）数据源改为自建；新增 `MikikoClientConfigService`（Mikiko 前缀）封装拉取与快照缓存；env `ZCODE_DYNAMIC_WORKFLOW_MODE` 本地覆盖逻辑保留。

### 4.2 模型预置配置自建（含管理页）

**公开端点**：`GET /api/v1/builtin-provider-config` → 返回 release JSON（即 `config/provider/zcode-builtin.json` 的形状，strict schema：`{schemaVersion: 1, revision: N, config: {providerConfigRules, modelConfigRules}}`；包含已退役 `builtin:zapi` 的 release 会被客户端整份拒绝，构造时不得携带）。当前体积约 176KB（KV 单值上限 25MB）。

客户端热更语义复用既有 `ZcodeBuiltinRemoteSynchronizer` 周期刷新：`revision` 递增才落新缓存；缓存目录按 endpoint 隔离，切源/回退零污染。

**客户端改动**：

- `node.ts:1533-1541` 的 `fetchRelease` 注入替换为新客户端 `MikikoBuiltinConfigClient`（新增类，Mikiko 前缀）：单跳直取自建端点，废弃官方两跳（client/configs → CDN）链路 `zcode-builtin-download.ts`。
- 端点来源 env：`MIKIKO_BUILTIN_CONFIG_URL`（默认 `https://agent.mikiko.ai/api/v1/builtin-provider-config`）。
- 打包内置 `config/provider/zcode-builtin.json` 继续作为离线 fallback。
- 存量类（`ZcodeBuiltinRemoteSynchronizer` 等）本次不强制重命名（导出引用面广）；仅要求**新增类型**一律 Mikiko 前缀，存量重命名列为后续可选清理项。

**初始化（上线前必做）**：2026-09-28 实测官方线上 `client/configs` 已停发 `builtin_provider_config_json` 字段（configs 仅剩 captcha/forceUpdate 等运营键），官方远端规则热更通道事实下线——客户端一直靠打包内置快照运行。因此种子源取仓库打包的 `config/provider/zcode-builtin.json`（本身就是合法 Release，当前 revision 30）：

```bash
node packages/mikiko-cloud/scripts/seed-builtin-config.mjs --dry-run   # 校验并产出 seed-builtin.json
node packages/mikiko-cloud/scripts/seed-builtin-config.mjs             # 校验 + wrangler kv 写入 current 与 revisions/r{N}
# 手工修正规则后导入：加 --file <path>
```

**数据维护方向**（管理页职责）：

1. 补全 GPT 系列（gpt-5.x 全变体、gpt-6）与 Claude 系列（claude-5.x 全变体）的 `modelRules` + 三种 apiType 的 `modelApiRules`（chat-completions / responses / anthropic-messages），确保 relay 场景（`resolveForRelayModel` 只叠加 model-api + 最具体 provider-site）能命中完整档位与映射。
2. 修复存量档位问题：GLM（glm-5/5.1/4.x）、qwen（3.5/3.6/3.7）、kimi-k2.5/2.6、mimo 的 `modelRules` 档位从 `disabled/enabled` 升级为上游实际支持的 effort 档位（`low/medium/high/xhigh/max`）并配齐 `reasoning_effort` 映射。
3. 每次发布 `revision` 严格递增；schema 校验不过禁止发布。

**管理页与鉴权**：

| 端点                                   | 方法    | 说明                                                                          |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `/admin`（页面）                       | GET     | 登录页 + 规则编辑器（JSON textarea + schema 校验 + 发布历史 + revision 预览） |
| `/api/v1/admin/login`                  | POST    | 账密校验 → 下发 HMAC-SHA256 签名 session cookie（httpOnly）                   |
| `/api/v1/admin/builtin-config`         | GET/PUT | 读取/发布当前规则（PUT 时服务端 schema 校验 + revision 自增 + 历史归档）      |
| `/api/v1/admin/builtin-config/history` | GET     | 历史版本列表（KV 多 key：`builtin-provider-config:r{N}`）                     |
| `/api/v1/admin/client-configs`         | GET/PUT | 维护 §4.1 自建功能配置                                                        |

鉴权材料全部走 Cloudflare 变量，**不进仓库不进代码**：

```bash
wrangler secret put MIKIKO_ADMIN_USERNAME
wrangler secret put MIKIKO_ADMIN_PASSWORD
wrangler secret put MIKIKO_ADMIN_SESSION_SECRET   # session cookie 签名密钥
```

登录失败统一 401 + 固定延迟（防爆破）；管理 API 一律验签 session cookie；管理页静态资源公开但无账密不可操作。

### 4.3 对话分享自建（彻底移除官方实现）

**协议面**（Worker 实现，与客户端 `conversationShareHttpClient.ts` 兼容）：

| 端点                                         | 方法 | 鉴权                    | 说明                                                                             |
| -------------------------------------------- | ---- | ----------------------- | -------------------------------------------------------------------------------- |
| `/api/v1/shares/device/register`             | POST | 无（IP 限流）           | 设备注册：`{deviceId: sha256(deviceMid)}` → `{deviceToken}`（服务端 KV 存 hash） |
| `/api/v1/shares/capabilities`                | GET  | 设备 token              | 能力发现（allowed_artifacts、access modes、schema_version）                      |
| `/api/v1/shares/preparations`                | POST | 设备 token + IP 限流    | 创建发布准备                                                                     |
| `/api/v1/shares/preparations/{id}/artifacts` | POST | 设备 token + IP 限流    | multipart 直传，流式转存 R2（Worker body 上限 100MB，覆盖附件场景）              |
| `/api/v1/shares/preparations/{id}/confirm`   | POST | 设备 token + IP 限流    | 落 KV 生成 share code                                                            |
| `/api/v1/shares/{code}/preview`              | GET  | 无（share code 即授权） | 公开预览                                                                         |
| `/api/v1/shares/{code}/continuation`         | POST | 无                      | 公开导入续聊                                                                     |

- 错误信封按客户端码表实现（`conversationShareHttpClient.ts:103` 起：3215/3217/3210 等；注意 3217 类服务端异常要显式映射，不再出现「未返回可定位详情」）。
- 存储：KV 放分享元数据与 rows，R2 放 artifacts（可复用 agent-dl 同款 R2 访问模式，但独立 bucket/prefix）。
- 落地页：`agent.mikiko.ai/cn/share/{code}`，复用 `packages/web` 的 `ConversationShareLandingPage` 构建（分享回调 `/cn/share/callback` 同域）。

**设备级 token**：复用 `packages/services/src/device/deviceMid.ts` 的持久化设备身份，**只上送哈希**（`sha256(deviceMid)`，原始值不出网）；`deviceToken` 长期有效，丢失可重新注册。

**IP 限流**：服务端强制执行——Worker 原生 Rate Limiting binding（按 IP，发布类端点默认 3 次/分钟），阈值从 KV 配置读取（管理页 `/api/v1/admin/client-configs` 可调），§4.1 自建 client/configs 下发同值供客户端提前提示。客户端收到 429 时按现有错误信封展示。

**官方分享移除面**（代码级）：

- `node.ts:2413`：分享 baseUrl 从 `buildRuntimeZCodeApiUrl(process.env, "/api/v1")` 改为 `MIKIKO_SHARE_API_BASE`（默认 `https://agent.mikiko.ai/api/v1`），不回退官方。
- `conversationShareService.ts:725-728`：`shareWebUrl` 默认 `https://agent.mikiko.ai/cn/share`；覆盖 env 由 `ZCODE_CONVERSATION_SHARE_WEB_URL` 改为 `MIKIKO_SHARE_WEB_URL`。
- `zcodeEndpoint.ts` 的 `webShareCallbackUrl` 构造同步指向 agent.mikiko.ai。
- tokenProvider：发布侧鉴权从 Zai token 改为设备 token（`auth: "required"` 语义保留，token 来源替换）；preview/continuation 维持无鉴权。

### 4.4 反馈与遥测关闭

- 反馈（已确认：**隐藏入口方式摘除**，代码保留便于日后恢复）：titleBar「问题上报」菜单项与 feedback center 入口隐藏；`createFeedbackService` 装配（`node.ts:2594`）与 `/feedback/*` 相关代码保留但不可达，不再出网。
- 遥测：`env.ts:58` `ZCODE_TELEMETRY_ENABLED = false`（硬关，含 onboarding 遥测）。

### 4.5 MIKIKO 前缀环境变量迁移

**本次新增（全部 MIKIKO 前缀）**：

| 变量                        | 默认值                                                   | 用途           |
| --------------------------- | -------------------------------------------------------- | -------------- |
| `MIKIKO_BUILTIN_CONFIG_URL` | `https://agent.mikiko.ai/api/v1/builtin-provider-config` | 模型预置规则源 |
| `MIKIKO_CLIENT_CONFIG_URL`  | `https://agent.mikiko.ai/api/v1/client/configs`          | 自建功能配置源 |
| `MIKIKO_SHARE_API_BASE`     | `https://agent.mikiko.ai/api/v1`                         | 自建分享 API   |
| `MIKIKO_SHARE_WEB_URL`      | `https://agent.mikiko.ai/cn/share`                       | 分享落地页     |

**可无缝双读迁移（MIKIKO* 优先，ZCODE* 回退一个版本期后移除）**——集中在运维可配的外部端点/开关，读取点收敛在 `pickProductEndpointEnv` 类函数：

| 现变量                                     | 迁移目标                                     | 读取点                           |
| ------------------------------------------ | -------------------------------------------- | -------------------------------- |
| `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` | `MIKIKO_BASE_URL` / `MIKIKO_ENDPOINT_ORIGIN` | `zcodeEndpoint.ts:18-33`         |
| `ZCODE_CDN_BASE_URL`                       | `MIKIKO_CDN_BASE_URL`                        | `remoteCdn.ts:19`                |
| `ZCODE_UPDATE_FEED_URL`                    | `MIKIKO_UPDATE_FEED_URL`                     | `autoUpdater.ts:26`              |
| `ZCODE_DYNAMIC_WORKFLOW_MODE`              | `MIKIKO_DYNAMIC_WORKFLOW_MODE`               | `dynamic-workflow-feature.ts:20` |
| `ZCODE_TELEMETRY_REPORT_ENDPOINT`          | `MIKIKO_TELEMETRY_REPORT_ENDPOINT`           | `env.ts:61`（关闭期保留读取口）  |

**不迁移**（内部机制/测试/身份类，改前缀收益低、风险高）：`ZCODE_ENV`、`ZCODE_DATA_BASE_DIR`/`ZCODE_HOME`/`ZCODE_LOG_DIR`/`ZCODE_DESKTOP_HOME_DIR`（路径体系）、`ZCODE_OFFPEAK_MOCK*`（测试）、CUA/AGENT_SERVER/REMOTE/SERVER/PLUGIN 系（进程间传参）、`ZCODE_UPDATES_ENABLED` 等。存量 `Zcode*` 类名同理不动，仅约束新增命名。

**存量 `Zcode*` 类名对客暴露评估（2026-09-28，结论：暂不重命名）**：对客可见面均已 Mikiko 品牌化——出网 UA 按品牌规范以 `Mikiko/` 开头（`specs/brand/outbound-user-agent.md`，含 WebFetch/插件安装器出口）；UI 文案无 ZCode 残留（i18n 中 `zcode` 仅存在于 key 名与 `x-zcode-bot-secret` 请求头说明、`.zcodeignore` 文件名等技术性内容）。类名仅存在于源码与诊断日志/stack trace（`~/.mikiko/v2/logs/`，技术受众），错误 UI 只展示 traceId 不展示 stack 类名。复查触发条件：若未来某个 `Zcode*` 类名进入对客错误消息、新 UI 展示文案或对外文档，须随该变更一并重命名。

顺带品牌残留清理（并入 P1）：`Mikiko-WebFetch` UA 括号内的联系 URL 仍为 `+https://zcode.ai`（`apps/zcode-cli/packages/core/src/tool/handlers/webfetch-constants.ts`），域名已定，随本方案更新为 `+https://agent.mikiko.ai`。注意 `X-Title`/`X-ZCode-App-Version` 等自定义请求头是官方后端契约（zai/codingplan 链路），继续保留不改。

### 4.6 插件市场（暂用官方，纳入后续自建范围）

本期不做，保持 `cdn-zcode.z.ai` 官方源（marketplace.json + `/official-plugin/assets`）。纳入自建时（P5）要求：

1. **先种子化后切换**：从官方同步完整数据到自建服务后才允许客户端切换，避免上线缺数据——
   - `marketplace.json` 拉取后校验（插件清单 schema）存 KV；
   - `/zcode/official-plugin/assets` 下的资产文件全量转存 R2（脚本遍历清单引用的资产 URL，逐个下载写入，校验大小/类型）；
   - 切换开关用 `MIKIKO_PLUGIN_MARKETPLACE_URL`（默认仍官方，灰度切自建），与 §4.5 双读模式一致。
2. 自建端点规划：`GET agent.mikiko.ai/api/v1/plugin-marketplace/marketplace.json` + `GET /api/v1/plugin-marketplace/assets/{key}`（R2 代理），管理页复用 §4.2 的 `/admin` 鉴权体系增加市场数据同步与发布操作。
3. 官方插件清单的增量更新可做成管理页一键「从官方同步」或定时任务，历史版本留档便于回退。

## 5. 客户端代码改动清单（按文件）

| 文件                                                                                                      | 改动                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/services/src/node.ts:1533-1541`                                                                 | `fetchRelease` 换 `MikikoBuiltinConfigClient`（读 `MIKIKO_BUILTIN_CONFIG_URL`） |
| `packages/provider-node/src/`（新增 `mikiko-builtin-config-client.ts`）                                   | 单跳下载 + strict schema 校验（复用 `decodeZCodeBuiltinRelease`）               |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts:98-126,239-266` | envelope 收窄；`dynamicWorkflow` 改读 `MikikoClientConfigService`               |
| `packages/services/src/`（新增 `mikiko-client-config/`）                                                  | 自建 client/configs 拉取 + 快照 + 限流配置下发                                  |
| `packages/services/src/node.ts:2409-2413`                                                                 | 分享 baseUrl → `MIKIKO_SHARE_API_BASE`；tokenProvider 换设备 token              |
| `packages/services/src/conversation-share/conversationShareService.ts:717-728`                            | `shareWebUrl` → `MIKIKO_SHARE_WEB_URL` 默认 agent.mikiko.ai                     |
| `packages/services/src/`（新增设备 token 注册，复用 `device/deviceMid.ts`）                               | `sha256(deviceMid)` 注册 + token 持久化                                         |
| `packages/desktop/src/main/`（titleBar 菜单）+ `node.ts:2594`                                             | 反馈入口与装配关闭                                                              |
| `packages/shared/src/env.ts:58`                                                                           | 遥测硬关                                                                        |
| `packages/shared/src/zcodeEndpoint.ts:18-33`                                                              | `pickProductEndpointEnv` 增加 MIKIKO\_ 双读                                     |

服务端（新工程，建议 `packages/mikiko-cloud/` 或独立仓库）：Worker + KV + R2 + 管理页前端 + `wrangler.jsonc`。

## 6. 实施顺序与验收场景

1. **P1 模型预置配置**：官方数据种子化 → Worker 端点 + 管理页 + 鉴权 → 客户端换源（`MIKIKO_BUILTIN_CONFIG_URL`）。
   - 验收：断网/自建接口 5xx 时客户端回落打包内置并可正常建模；管理页发布 revision+1 后客户端 ≤1 个刷新周期拿到新规则；`resolveRelayModelRecommendation` 对 gpt-_/claude-_ 返回完整档位与映射；schema 非法 JSON 无法发布。
2. **P2 反馈/遥测关闭 + client/configs 收窄**：与 P1 同批收尾。
   - 验收：设置页无反馈入口、进程无 `/feedback/*` 出网；官方 client/configs 仍被调用（套餐/StartPlan/闲时正常）；「工作流」标签按自建配置出现（自建接口异常时默认 enabled）。
3. **P3 分享自建**：Worker 分享协议 + 设备 token + 限流 + 落地页 → 客户端切换并移除官方链路。
   - 验收：全流程（capabilities → preparations → artifacts → confirm → 落地页预览 → continuation 导入）走 agent.mikiko.ai；第 4 次/分钟发布被 429 且客户端提示可读；无 Zai 登录态也能发布（设备 token）；官方分享域名零请求。
4. **P4 MIKIKO\_ 双读迁移**：随上述各批落地，最后统一核对无遗漏 `ZCODE_` 运维变量读取。

## 7. 决策记录与遗留项

已确认：保留 Zai/CodingPlan 全链路；`dynamicWorkflow` 入口保留（配置源迁自建，默认 enabled）；分享发布鉴权 = 设备级 token + IP 限流（3/min，远端可配）；分享彻底去官方；新变量/新类一律 Mikiko 品牌；**反馈以隐藏入口方式摘除（代码保留）**；**`Zcode*` 存量类经评估无对客暴露风险，暂不重命名**（评估依据与复查触发条件见 §4.5，顺带的 WebFetch UA 联系 URL 清理并入 P1）；**插件市场暂用官方源，纳入后续自建（P5），切换前必须先种子化官方数据**（见 §4.6）。

遗留（review 后登记，2026-09-28）：设备 token 的 3201 自动恢复（服务端重注册覆盖旧 secret 后，客户端需清缓存重注册一次——当前需重启进程）；preparation 状态机在 KV 上的并发丢更新与 3210 间歇风险（客户端串行上传 + 用户级重试兜底，如需强一致改 Durable Object/D1）；`webShareCallbackUrl` 仍指官方（与 web 端 Zai OAuth redirectUri 共用字段，拆分需与 web OAuth 注册一起做）；`getForceUpdateConfig` 保留无消费方（接口兼容）；`getSharePublishRateLimit` 的「发布前提示」尚未接入 UI（服务端已强制限流）；`ZCODE_DYNAMIC_WORKFLOW_MODE` 与 `ZCODE_TELEMETRY_REPORT_ENDPOINT` 保留原名不迁移（前者被 desktopRuntimeEnv 改写逻辑引用，后者已随遥测关闭失效）；artifacts 上传内存缓冲（≤25MB/文件，并发多文件时 isolate 内存需观测）。
