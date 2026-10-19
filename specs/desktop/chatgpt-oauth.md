# ChatGPT OAuth 账号接入技术方案（评审稿 v2）

> 状态：待评审（未实施）。评审通过后本文档作为实现 spec。
> 权威参考（按优先级）：**官方 Codex CLI**（`/Users/fatballfish/Documents/Projects/RustProjects/Public/codex`，codex-rs，下称「官方」）——OAuth、刷新、错误处理、请求栈、生图均以官方实现为准；**sub2api**（`/Users/fatballfish/Documents/Projects/GoProjects/Personal/sub2api`）作为补充参考（quota UI 端点、订阅到期、请求体改写经验）。
> 注意：本仓库 `ISub2ApiService`（中转站）与 sub2api 参考项目是两回事，本文所有 sub2api 引用均指参考项目。

## 0. 需求映射

| #   | 需求                                                                               | 方案章节   |
| --- | ---------------------------------------------------------------------------------- | ---------- |
| 1   | 模型设置新增「ChatGPT」分类，列出账户（ChatGPT 图标 + 名称/邮箱）                  | §9.1       |
| 2   | 添加供应商「ChatGPT OAuth」：风险提醒 + 授权链接 + 临时回调监听                    | §4.1、§4.2 |
| 3   | 账号详情页：订阅/额度窗口/重置次数/模型列表 + 刷新/刷新令牌/退出登录/重新授权/重置 | §5、§9.2   |
| 4   | 后台定时刷新令牌；左下角菜单展示 ChatGPT 账户                                      | §6、§9.5   |
| 5   | 会话模型选择器展示所有授权正常账号的模型并可发起请求（Responses 协议）             | §7         |
| 6   | 系统设置 ChatGPT 页：UA 模拟（版本号走 Mikiko 远端配置）、Fast/Flex 策略           | §8、§10    |
| 7   | 上下文统计展示订阅剩余额度 + 重置按钮（全窗口生效）                                | §9.6       |
| 8   | 请求异常处理：不只 401/403，按官方错误矩阵处理（429 用量上限、5xx、流内错误等）    | §7.5       |
| 9   | 图片生成/编辑接口（generations/edits），为独立生图功能铺路；其他可移植能力         | §7.6、§7.7 |
| 10  | 独立 CLI 移植草案（P2，OAuth 登录 + 正常请求）                                     | §12        |

## 1. 范围与边界

- 仅桌面端（Electron）。Web 端不做。
- 仅 ChatGPT 账号 OAuth（官方 Codex CLI client_id），不支持 PAT/API Key 型（已有「自定义供应商」覆盖）。
- 推理协议只实现 OpenAI **Responses**（`https://chatgpt.com/backend-api/codex/responses`），不做 WebSocket 传输、不做图像桥接进 agent 工具链。
- 图片生成/编辑：v1 落地 **host 侧 API 客户端能力**（`images/generations` / `images/edits`），不做生图 UI（后续独立生图功能直接复用）。
- 独立 CLI（standalone）首期不接（P2 草案见 §12）：请求鉴权依赖 host 反向 RPC。

## 2. 调研结论（决定方案的关键事实）

### 2.1 本仓库现状

- **provider 三层目录**：zcode-builtin（远端内置目录，`packages/mikiko-cloud/seed-builtin.json` 发布）→ personal → account（host 推送信封）。resolver 要求 account 层 provider 必须已存在于 builtin 层（`packages/provider/src/resolver.ts:184-190`），信封 schema 目前只接受 `{builtinModelIds, access: zhipu-account}`（`packages/provider/src/config/schema.ts:26-30`）。多账号需放宽这两处（§7.1）。
- **请求鉴权链路现成**：CLI 每 attempt 前经 `interaction/requestProviderRuntimeHeaders` 向 host 索取 `requestAuth {apiKey?, headers?}`（`packages/shared/src/zcode-protocol/index.ts:2392-2444`；host 应答 `zcodeAgentService.ts:2245-2292` → `accountProviderRequestAuthService`）。凭证不经 env/配置文件进 CLI。
- **模型工厂已有 Responses 客户端**：`apps/zcode-cli/packages/adapters/src/model/model-execution.ts` 用 `@ai-sdk/openai` 的 `.responses`，已有按 provider 改写 fetch 的先例（`official-coding-plan-gateway.ts`）。
- **凭据存储**：`{appConfigDir}/credentials.json`，AES-256-GCM + 文件锁 + 原子写。
- **远端配置**：mikiko-cloud worker `client-configs` KV（fail-open 默认值 + admin 写入口），客户端 `mikikoClientConfigService`（1h TTL）。

### 2.2 官方 Codex CLI 结论（修正 sub2api 口径的部分）

| 项          | 官方实现                                                                                                                                                                                                                                                                                                                                                                                                                    | 对方案的影响                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| PKCE        | verifier = **base64url-nopad(64 随机字节)**；challenge = base64url-nopad(SHA256(verifier ASCII))；S256（`login/src/oauth/pkce.rs:14-29`）                                                                                                                                                                                                                                                                                   | ❌ 修正 sub2api 的 hex 编码口径                                                                                                                      |
| 回调        | `http://127.0.0.1:{port}/auth/callback`，主端口 **1455**，官方占用时会踢旧实例（`GET /cancel`）再重试、仍失败换 **1457**                                                                                                                                                                                                                                                                                                    | 端口与 host 取官方值；**占用行为按需求裁定：直接中断授权**（见 §4.2）                                                                                |
| scope       | `openid profile email offline_access api.connectors.read api.connectors.invoke`；authorize 还带 `originator=codex_cli_rs`                                                                                                                                                                                                                                                                                                   | ❌ 修正 sub2api 窄 scope；refresh **不带 scope**                                                                                                     |
| 刷新        | JSON body `{grant_type:"refresh_token", client_id, refresh_token}`；**主动刷新提前量 5 分钟**（按 access_token JWT `exp`）；无 exp 时 `last_refresh > 8 天` 兜底；401 时 Reload→Refresh→重试一次；**Permanent 失败缓存短路**；Semaphore(1) 并发锁；RT 轮换仅非空覆盖                                                                                                                                                        | ❌ 修正 sub2api 的 form 编码 + 30 分钟窗口；§6 全面对齐                                                                                              |
| HTTP 客户端 | **标准 reqwest（rustls/native-tls 默认指纹），无任何 TLS/HTTP2 指纹伪装**；Cloudflare 处理 = **cookie 白名单 jar**（`__cf_bm/__cflb/__cfruid/__cfseq/__cfwaitingroom/_cfuvid/cf_clearance/cf_ob_info/cf_use_ob/cf_chl_*/__oailb`，仅 chatgpt.com 域、仅 HTTPS；`http-client/src/chatgpt_cloudflare_cookies.rs`）                                                                                                            | ❌ 推翻「需要 Chrome TLS 指纹」假设：Node fetch 可行，需移植 **CF cookie jar**                                                                       |
| 请求头      | `originator`、`User-Agent: {originator}/{ver} ({os} {osVer}; {arch}; {terminal})`、`version`、`Authorization`、`ChatGPT-Account-ID`、FedRAMP `X-OpenAI-Fedramp: true`、流式 `Accept: text/event-stream`、`session-id`/`thread-id`（小写）、`x-client-request-id`、`x-codex-beta-features: remote_compaction_v2`；**HTTP 请求不发 OpenAI-Beta**（仅 WS 发）                                                                  | §7.2 头清单更新；❌ 移除 sub2api 的 `OpenAI-Beta: responses=experimental`                                                                            |
| 请求体      | `store:false`、`stream:true` 恒定；`include:["reasoning.encrypted_content"(,"output.encrypted_content")]`；`prompt_cache_key = session_id`；ThreadId=UUIDv7；instructions 不用字段而是 developer 前缀项                                                                                                                                                                                                                     | 保持 instructions 字段（sub2api 已验证上游接受，AI SDK 自动映射 system→instructions）                                                                |
| 模型清单    | `GET /codex/models?client_version={取整版}`，**全量 GET + 响应 ETag 比对续期**（非 If-None-Match），5s 超时，失败回退打包 `models.json`（11 slugs）；manifest 含 `visibility(list                                                                                                                                                                                                                                           | hide)`、`service_tiers`、`default_service_tier`、`context_window`、推理档位、每模型 `instructions_template`；推理响应头 `X-Models-Etag` 触发后台刷新 | §5 模型列表机制对齐 |
| 生图        | 官方支持：`POST {base}/images/generations`、`POST {base}/images/edits`，模型 **`gpt-image-2`**（1.5 兼容），响应 `{data:[{b64_json}]}`，独立限流 id `image_gen`（头族 `x-image-gen-primary-*`），请求头 `x-codex-image-turn-id`（`codex-rs/ext/image-generation/`、`codex-api/src/endpoint/images.rs`）                                                                                                                     | §7.6 直接移植                                                                                                                                        |
| 账户信息    | 邮箱/plan 均来自 **本地 id_token claims**（无 display name 字段）；但 `GET /wham/accounts/check` 的账号列表 **含 `name`/`profile_picture_url`**（`backend-client/src/types.rs:137-152`）                                                                                                                                                                                                                                    | 账户展示名称可获取（§3.1、§9.1）                                                                                                                     |
| 错误矩阵    | 401→恢复状态机；403 含 Cloudflare HTML 豁免与 `misalignment_policy_violation`；429 按响应体 `error.type=usage_limit_reached`（含 `plan_type/resets_at/limit_window_minutes`）+ 头族 `x-codex-active-limit`、`x-{limit}-{primary,secondary}-*`、`x-codex-credits-*` 分类为终态/可重试；5xx 重试 4 次（200ms×2、jitter、尊重 Retry-After）；流内错误码分类（`server_is_overloaded`/`slow_down`/`context_length_exceeded` 等） | §7.5 全矩阵移植                                                                                                                                      |
| 登出        | 先 best-effort `POST /oauth/revoke` 再清本地                                                                                                                                                                                                                                                                                                                                                                                | §6 纳入                                                                                                                                              |

## 3. 数据模型与存储

### 3.1 账号记录（唯一事实 owner：host `ChatGPTAccountService`）

```
packages/shared/src/chatgpt-account.ts（新）：

ChatGPTAccountRecord {
  accountId: string            // chatgpt_account_id（id_token claims），主键，重复授权按此覆盖
  email: string                // id_token 顶层 email ?? profile.email
  displayName?: string         // wham/accounts/check 的 account.name，获取失败为空（UI 回退邮箱）
  avatarUrl?: string           // 同上 profile_picture_url
  createdAt / updatedAt: string
  credentials: {
    accessToken, refreshToken: string
    accessTokenExpiresAt?: string      // access_token JWT exp（RFC3339）；无 exp 时用 lastRefreshAt 兜底
    lastRefreshAt: string
    clientId: string                   // 兑换用 client_id，刷新回带
  }
  permanentRefreshFailure?: { reason: string; at: number }   // 官方 Permanent 失败缓存：同凭证快照直接短路，不反复打刷新接口
  profile: { planType: string; planExpiresAt?: string; isDefault: boolean; isFedramp: boolean }
  usage?: ChatGPTUsageSnapshot         // §5.2
  resetCredits?: { availableCount: number; credits: { id; expiresAt; status }[] }
  models?: { slugs: string[]; etag?: string; updatedAt: string }
  status: {
    state: "active" | "auth-error" | "cooldown" | "rate-limited"
    reason?: string
    resetsAt?: string                  // rate-limited/cooldown 的恢复时间（429 resets_at）
    updatedAt: number
  }
}
```

- 存储：`ICredentialService` 单键 `chatgpt-accounts`（整表 JSON，加密，文件锁 + 原子写）。renderer 只拿脱敏视图（不含 credentials）。
- 账号变更事件：`onDidChangeAccounts` → renderer（设置页/侧栏/上下文统计）与账号信封推送（§7.1）都由它驱动。

### 3.2 常量（全部取官方值）

```
CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"     // manager.rs:1718
AUTHORIZE_URL           = "https://auth.openai.com/oauth/authorize"
TOKEN_URL               = "https://auth.openai.com/oauth/token"
REVOKE_URL              = "https://auth.openai.com/oauth/revoke"
REDIRECT_URI            = "http://127.0.0.1:1455/auth/callback"
SCOPE_LOGIN             = "openid profile email offline_access api.connectors.read api.connectors.invoke"
CHATGPT_BACKEND_ORIGIN  = "https://chatgpt.com/backend-api"
CODEX_ORIGINATOR        = "codex_cli_rs"
CODEX_VERSION_FALLBACK  = "0.146.0"        // 代码内置兜底；版本号上限/维护见 §10
IMAGE_MODEL             = "gpt-image-2"
CF_COOKIE_NAMES         = ["__cf_bm","__cflb","__cfruid","__cfseq","__cfwaitingroom",
                           "_cfuvid","cf_clearance","cf_ob_info","cf_use_ob","__oailb"] // + 前缀 cf_chl_*
```

## 4. OAuth 授权流程

### 4.1 入口与风险提醒（需求 5 补充）

「添加供应商 → ChatGPT OAuth」卡片点击后，先弹确认对话框（每次添加都展示，不做「不再提醒」）：

> **风险提醒**：在 Mikiko 中添加 Codex 账户，非官方 Codex 客户端的使用方式可能导致账户被降智（模型质量/限额调整）或其他限制后果。继续添加即视为你接受上述风险。

点击「继续添加」才进入 §4.2 授权流程。

### 4.2 流程（对齐官方 login server）

```
设置页(renderer)            ChatGPTAccountService(host)                系统浏览器 / auth.openai.com
   │ startAuthorization() ──▶ 1. state=base64url(32B)、PKCE(64B→base64url-nopad)、
   │                          challenge=base64url-nopad(sha256(verifier))
   │                          2. 绑定 http://127.0.0.1:1455（仅 127.0.0.1）
   │                             端口被占 → 中断授权，报错文案提示「1455 被占用，
   │                             可能是 Codex CLI 正在运行/登录中，请关闭后重试」
   │ ◀── { authUrl, sessionId } ┘ （授权会话 TTL 10min）
   │ platform.openExternal(authUrl) ───────────────────────────▶ 用户登录授权
   │                          ◀── GET /auth/callback?code&state
   │                              - state 常量时间比较；不匹配 → 400 "State mismatch"
   │                              - error=access_denied 且描述含 missing_codex_entitlement
   │                                → 专属文案「该账户无 Codex 使用资格」
   │                          3. POST TOKEN_URL（form-encoded）:
   │                             grant_type=authorization_code / client_id / code /
   │                             redirect_uri / code_verifier（连接超时 10s，无响应超时）
   │                          4. 解析 id_token claims（base64 payload，校验 exp，不验签）:
   │                             email = 顶层 email ?? "https://api.openai.com/profile".email
   │                             auth = "https://api.openai.com/auth"
   │                               → chatgpt_account_id / chatgpt_plan_type /
   │                                 chatgpt_user_id ?? user_id / chatgpt_account_is_fedramp
   │                          5. enrich（§5）：wham/accounts/check（含 name/avatar）、
   │                             usage、reset-credits、codex/models 首拉
   │                          6. 回调响应：302 → 本地 /success 页（官方简化流成功页文案）
   │                          7. 写 credential；关 listener；推账号信封；广播 onDidChange
   │ ◀── onAuthorizationCompleted({accountId, email, displayName}) / onAuthorizationFailed
```

- 同时刻仅允许一个进行中授权；`cancelAuthorization()` 关 listener 并返回浏览器端 `/cancel` 提示。
- 「重新授权」同流程，成功后按 accountId 覆盖（保留 createdAt，清空 permanentRefreshFailure/status）。
- 不做官方的 1457 fallback 端口与踢旧实例逻辑（用户裁定：占用即中断）。
- 官方的 api-key token-exchange（`urn:ietf:params:oauth:grant-type:token-exchange`）不移植（我们只用 access_token）。

**网络出口与可观测性（2026-10-17 修订）**：整个登录链路的 host 侧出站请求——token
兑换 / 刷新 / revoke（auth.openai.com）与 §5 的 wham/codex backend（chatgpt.com）——
统一走 host API 网络 transport（`createHostApiNetworkTransport`，owner 为 node.ts 装配
处，与 NodeApiClient 共享同一实例）：设置页「常规 → HTTP 代理」的 httpProxy /
NoProxy / 自定义 CA 全部生效；未配置时保持直连，行为与裸 fetch 一致。原因：host 是
独立 Node 进程，Electron Session.setProxy 与系统代理都不影响它的 `globalThis.fetch`；
浏览器能经系统代理完成授权，host 直连 auth.openai.com 却失败，就会呈现「回调页已示
登录成功、客户端提示添加失败」。

- 回调成功页在 code→token 兑换**之前**返回（官方口径）；因此浏览器成功 ≠ 账号已添加，
  兑换/写库失败只经 `onAuthorizationFailed` 透出。
- 兑换/刷新的网络错误（fetch 抛错/超时）包装为 `ChatGPTOAuthError` 且分类
  `transient/network`（与刷新既有口径一致）；授权失败（done reject）时 host 落
  `warn` 日志（错误名/消息/HTTP 状态/错误码，不含 token），事件文案对网络错误
  指引「设置 → 常规 → HTTP 代理」配置代理后重试。

### 4.3 添加路径二：导入 sub2api 导出文件

添加 ChatGPT 账号的对话框提供两个入口：「浏览器授权」（§4.2）与「导入 sub2api 导出文件」。后者读取用户从 sub2api 面板导出的账号 Session JSON，取其中 ChatGPT OAuth 数据建立账号（**不读取 proxies 与 extra**，账号信息一律通过接口重新补全）。

导出文件格式（sub2api 实测样例 `sub2api-account-*.json`）：

```jsonc
{
  "exported_at": "…",
  "proxies": [],                        // 忽略
  "accounts": [{
    "name": "…",                        // 忽略
    "platform": "openai",               // 仅取 platform==="openai" && type==="oauth"
    "type": "oauth",
    "credentials": {
      "access_token": "…", "refresh_token": "rt.1…", "id_token": "…",
      "chatgpt_account_id": "…",        // 必需，缺失则该条 skip
      "chatgpt_user_id": "…", "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
      "email": "…", "expires_at": "RFC3339", "plan_type": "pro",
      "organization_id": "…", "subscription_expires_at": "RFC3339",
      "model_mapping": { … }            // 忽略
    },
    "extra": { … },                     // 忽略（usage 快照等一律重拉）
    "concurrency": 10, "priority": 50, "rate_multiplier": 1,
    "auto_pause_on_expired": true       // 忽略
  }]
}
```

导入流程与契约（伪代码见附录 A.6）：

```
renderer(添加对话框「导入 sub2api」)   ChatGPTAccountService(host)
   │ 选文件（平台文件选择器，.json）──▶ importSub2ApiAccounts(filePath)
   │                                  1. 读文件 + JSON.parse（≤2MB）
   │                                  2. parseSub2ApiAccountExport：
   │                                     过滤 openai+oauth 且有 refresh_token；
   │                                     accountId=chatgpt_account_id（必需）；
   │                                     accessTokenExpiresAt = JWT exp ?? expires_at；
   │                                     clientId = credentials.client_id ?? 官方值
   │                                  3. 逐条落库：accountId 已存在 → 覆盖凭证并标记 updated；
   │                                     status/permanentRefreshFailure 重置
   │                                  4. 逐条 enrichAccountInfo（§5 四个接口；
   │                                     单条失败不回滚账号，标记待刷新，结果里报 warning）
   │                                  5. 推账号信封 + 广播
   │ ◀── { imported: [{accountId,email,state:"created"|"updated"}],
   │        skipped: [{name,email?,reason}], enrichFailures: [...] }
```

- 风险提醒（§4.1）对导入路径同样生效（选择入口前展示，继续即接受）。
- 敏感数据处理：解析仅在 host 内存进行；原始文件不复制、不入库；日志不落 token。

## 5. 账号信息与模型列表（host 拉取）

请求走 host API 网络 transport（§4.2：与 OAuth 端点共用同一实例，httpProxy/CA 设置生效）+ §7.2 身份头 + §7.3 CF cookie jar。

| 信息      | 端点                                                  | 说明                                                                                                                                                                                                                                                                 |
| --------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账户/订阅 | `GET {origin}/wham/accounts/check`                    | 官方现行口径；账号列表含 `id/plan_type/name/profile_picture_url/is_default`。订阅到期：`GET {origin}/subscriptions?account_id=`（`active_until`；sub2api 验证过的补充口径，官方不调）                                                                                |
| 额度窗口  | `GET {origin}/wham/usage`                             | `rate_limit.primary_window/secondary_window {used_percent, limit_window_seconds, reset_after_seconds, reset_at}`；归一化：两窗口 `window_minutes` 小者=5h、大者=7d；`additional_rate_limits`（30D 等其他窗口、`image_gen` 用量）原样透出；`credits.balance` 剩余额度 |
| 重置次数  | `GET {origin}/wham/rate-limit-reset-credits`          | `available_count` + `credits[]{id, expires_at, reset_type, status}`；仅计 `reset_type=="codex_rate_limits" && status=="available"`                                                                                                                                   |
| 模型列表  | `GET {origin}/codex/models?client_version={取整版本}` | 官方机制：全量 GET + 响应 **ETag** 比对续期（磁盘缓存 keyed by etag）；5s 超时失败回退内置静态列表；`visibility=="hide"` 的 slug 过滤掉；其余与内置目录已知 slug 求交（§7.1）                                                                                        |
| 重置额度  | `POST {origin}/wham/rate-limit-reset-credits/consume` | body `{redeem_request_id: uuid-v4}`（幂等键，重试复用）；成功后重拉 usage + reset-credits 并广播                                                                                                                                                                     |

刷新入口统一 `refreshAccountInfo(accountId)`：详情页刷新 icon、重置后置处理、被动头更新（§7.5）、后台任务共用；结果原子写回并触发 `onDidChangeAccounts`。推理响应头 `X-Models-Etag` 变化 → 后台刷新模型列表（官方行为）。

## 6. Token 生命周期（对齐官方 AuthManager）

- **主动刷新提前量：`exp - now ≤ 5 分钟`**（按 access_token JWT exp）；**无 exp 时 `lastRefreshAt > 8 天` 兜底**。
- **请求路径惰性刷新**：host `resolveCurrent`（§7.4）发现到期窗口内先刷新再用。per-account in-flight 互斥（官方 Semaphore(1) 等价），刷新成功写回 + 更新 lastRefreshAt。
- **后台定时任务（需求 4 保留）**：host `ChatGPTAccountRuntime` 每 5 分钟扫描全部账号，命中 5 分钟窗口或 8 天兜底即刷新——保证不开会话也能续期；请求路径惰性检查作为兜底（如休眠错过定时器）。
- **刷新请求**（官方口径，❌ 修正 sub2api）：`POST TOKEN_URL`，**JSON** body `{"grant_type":"refresh_token","client_id":<record.clientId>,"refresh_token":...}`，**不带 scope**。
- **RT 轮换**：响应字段非空才覆盖（`refresh_token` 可能不返回）；`id_token` 非空时顺带更新 email/plan claims。
- **失败定级（官方 `classify_refresh_token_failure`）**：HTTP 401、`400 + invalid_grant`、错误码 `refresh_token_expired / refresh_token_reused / refresh_token_invalidated` → **Permanent**（写 `permanentRefreshFailure` 缓存，同凭证快照后续刷新直接短路，账号置 `auth-error`，需重新授权）；5xx/网络 → Transient（保留旧 token 可用至 401，不置异常态）。
- **手动刷新令牌**：详情页按钮 → 强制刷新（互斥保护），失败按上述定级。
- **登出**：best-effort `POST REVOKE_URL`（JSON `{"token","token_type_hint":"refresh_token","client_id"}`，10s 超时，失败仅 warn）→ 删本地记录 → 摘模型信封。

```
时序（所有者标注）：
CLI transport(每 attempt) ──requestProviderRuntimeHeaders──▶ host accountRequestAuthService
   host: exp≤now+5min? ──▶ refresh(互斥) ── Permanent? ──▶ auth-error + 摘模型 + 广播
   host ──▶ requestAuth{apiKey: accessToken, headers: 身份头}
CLI 请求收到 401 ──▶ transport 本地恢复：强制重新取 headers(host 刷新) → 重试一次
   再 401 ──▶ 上报 host → auth-error（§7.5）
ChatGPTAccountRuntime(每 5min) ──▶ 到期窗口扫描刷新（与请求路径共用互斥与 Permanent 缓存）
```

## 7. 请求链路（CLI 执行）

### 7.1 账号 → Registry（多账号投影）

- 内置目录（seed-builtin.json + 远端 release）新增 provider 模板 `chatgpt`（api: `openai-responses` + `https://chatgpt.com/backend-api/codex`，logo key `chatgpt`）+ 已知 Codex slug 的模型规则（enabled/上下文窗口/推理档位；官方 fallback 目录 11 slugs + 现有 openai 模板重叠部分）。Registry 只发布 `enabled===true` 模型，manifest 未知 slug 记 debug 跳过。
- host 把每个授权正常账号投影为动态 account provider `account:chatgpt:{accountId}`：`builtinModelIds = 模型列表 ∩ 目录已知 slug`（过滤 hide）、`access = {type:"chatgpt-account", accountId, entitled}`、`api`（固定 baseUrl）+ `group:"chatgpt-family"` + logo。信封 schema 与 resolver 过滤放宽（§11）。
- 无「当前账号」概念：多账号并存，`states[id].current` 恒 `true`；异常时 `availability:"unavailable"` + `entitled:false` + `unavailableReason:"credential-failed"`（复用现有枚举，理由见 §11 评估）。
- 信封变化（增删/异常/模型刷新）→ 既有 `providerUpdateAccountConfig` 推送 → CLI Registry 刷新 → 选择器自动增减。

### 7.2 身份头（host 与 CLI 共用 builder，放 shared）

```
originator:              codex_cli_rs
user-agent:              {originator}/{codexVersion} ({osType} {osVersion}; {arch}; {terminalToken})
                         // 平台三段取真实系统信息；terminalToken 为常量（见 §16 开放问题 2）
version:                 {codexVersion}                  // §8 版本优先级
authorization:           Bearer <accessToken>            // 经 requestAuth.apiKey 注入
chatgpt-account-id:      {accountId}
x-openai-fedramp:        true                            // 仅 FedRAMP 账号
accept:                  text/event-stream               // 推理流式请求
session-id / thread-id:  会话稳定 id（小写头名）
x-client-request-id:     同 thread-id
x-codex-beta-features:   remote_compaction_v2            // 官方无条件通告
（HTTP 不发 OpenAI-Beta —— 仅 WS 场景使用，官方口径）
```

UA 模拟关闭时：`user-agent`/`originator`/`version` 换 Mikiko 自身标识（UI 注明可能被上游拒绝）。

### 7.3 Cloudflare 处理（官方方式）

**不做 TLS 指纹伪装**（官方即 reqwest 默认指纹）。移植官方 **CF cookie 白名单 jar**：

- 在 CLI transport（chatgpt 请求）与 host 的 wham/images 请求中共用一份进程内 cookie 存储（host 侧持久化到内存即可，重启重建）。
- 仅 `chatgpt.com` / `chat.openai.com` 域、仅 HTTPS；只存 §3.2 白名单名（含 `cf_chl_*` 前缀）与 `__oailb`（遵守其 Path/过期语义）；绝不存账号/会话 cookie。
- 请求前回放 `Cookie` 头，响应后从 `set-cookie` 收集。

### 7.4 请求期鉴权（host 侧）

`accountProviderRequestAuthService.resolveCurrent` 新增 chatgpt-account 分支：读记录 → 5 分钟窗口内先刷新（§6）→ 返回 `requestAuth {apiKey: accessToken, headers: §7.2 身份头}`。CLI 侧两处放宽：`provider-registry-model-runtime.ts:79-88`（requestAuth 绑定条件加 chatgpt-account）、`model-execution.ts`（chatgpt-account 不取静态 apiKey）。

### 7.5 错误处理矩阵（需求 8，官方全量移植）

CLI transport 收到错误 → 按「请求级行为（transport 内）」+「账号级上报（host）」双轨处理：

| 状态/错误                                                             | transport（请求级）                                                                      | host（账号级，经上报通知）                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **401**                                                               | 本地恢复：强制重新取 requestAuth（触发 host 刷新）→ **重试一次**；再 401 → 终止上报      | 置 `auth-error`（若刷新 Permanent 则带 reason）→ 摘模型信封 → UI「重新授权」                                                                                           |
| **403**（结构化）                                                     | 终止，不可重试                                                                           | `auth-error`（reason=响应 code，如 `misalignment_policy_violation`）→ 摘模型                                                                                           |
| **403**（Cloudflare HTML/blocked）                                    | 按网络错误处理（重试 5xx 档）                                                            | **不动账号状态**（官方豁免语义）                                                                                                                                       |
| **402 / deactivated_workspace / account_disabled**                    | 终止                                                                                     | `auth-error`（reason）→ 摘模型                                                                                                                                         |
| **429 `usage_limit_reached`**                                         | 终态不自动重试（官方 retry_429=false）                                                   | 不摘模型；解析 body `plan_type/resets_at/limit_window_minutes` + 头族 → 更新 usage 快照 → `status: rate-limited + resetsAt` → 用量面板展示（文案参考官方按 plan 分档） |
| **429 其他（quota 类 / usage_not_included / flex_unavailable）**      | 终态                                                                                     | 更新快照；`flex_unavailable` 仅提示当前 tier 不可用                                                                                                                    |
| **400 策略类（cyber/bio policy、invalid_prompt）**                    | 终态，错误透传给会话                                                                     | 不动账号状态                                                                                                                                                           |
| **5xx / 408 / 网络错误**                                              | 重试：4 次、200ms×2ⁿ、jitter 0.9-1.1、尊重 `Retry-After`；流断重连 5 次、流空闲超时 300s | 不动账号状态                                                                                                                                                           |
| **流内 `server_is_overloaded` / `slow_down` / `rate_limit_exceeded`** | 按 Retry-After 或本地退避重试（官方口径）                                                | 不动账号状态                                                                                                                                                           |
| **流内 `context_length_exceeded` / 配额终态码**                       | 终态透传                                                                                 | 更新快照（如适用）                                                                                                                                                     |

被动用量更新：每次响应头 `x-codex-active-limit` + `x-{limit}-{primary,secondary}-{used-percent,window-minutes,reset-at}` + `x-codex-credits-*`（30s 节流）与 SSE `codex.rate_limits` 事件 → 上报 host 更新 usage 快照。上报协议：新增 CLI→host 通知 `provider/reportChatGPTRequestOutcome {providerId, kind: "auth-error"|"usage", status?, errorCode?, usageHeaders?}`（一个方法承载，避免碎片化）。

### 7.6 图片生成/编辑客户端（需求 9，host 能力铺垫）

新 `packages/services/src/chatgpt/chatgptImagesClient.ts`（对齐官方 `ext/image-generation` + `endpoint/images.rs`）：

- `generateImage(accountId, {prompt, size?, quality?, background?, n?})` → `POST {origin}/codex/images/generations`
- `editImage(accountId, {images: string[] /* data URL */, prompt, ...})` → `POST {origin}/codex/images/edits`
- 请求体：`{prompt, background: transparent|opaque|auto, model: "gpt-image-2", quality: low|medium|high|auto, size: auto|1024x1536|..., n?}`（edits 的 `images[]` 支持 data URL，官方 file_id 引用不移植）。
- 头：§7.2 身份头 + `x-codex-image-turn-id: {uuid}`；响应 `{created, data:[{b64_json, generation_id?}]}`；错误诊断头 `x-codex-imagegen-request-id` 记日志。
- 限流：`image_gen` 独立额度（头族 `x-image-gen-primary-*`），解析进 usage 快照的 additional windows。
- 经 `ChatGPTAccountService` RPC 暴露（`generateImage/editImage`），v1 无 UI；供后续独立生图功能与技能调用。

### 7.7 其他可移植能力（官方清单裁定）

| 能力                                                                 | 裁定                                    |
| -------------------------------------------------------------------- | --------------------------------------- |
| CF cookie jar、限流头/usage 事件解析、models ETag 刷新               | **v1 纳入**（§5、§7.3、§7.5）           |
| 429 用量上限的 plan 分档文案                                         | **v1 纳入**（用量面板/错误提示）        |
| web_search hosted tool / 独立 `/alpha/search`                        | 后续（依赖 agent 工具链改造，单独立项） |
| remote compaction v2（`x-codex-beta-features` 已通告，请求侧零成本） | v1 仅通告头；能力本体后续               |
| turn metadata（`client_metadata["x-codex-turn-metadata"]`）          | 后续（服务端可观测性增强）              |
| view_image 工具、Responses over WebSocket、云任务/记忆/realtime      | 不移植（与现有架构重叠或无场景）        |

## 8. UA 模拟与 Fast/Flex 策略（设置）

新增 App 设置（`validationAppSettings.ts`）：

| 键                            | 默认     | 说明                                                                             |
| ----------------------------- | -------- | -------------------------------------------------------------------------------- |
| `chatgptCodexUaSimulation`    | `true`   | §7.2/§7.3 身份三元组开关                                                         |
| `chatgptCodexVersionOverride` | 空       | 手动版本覆写（调试）                                                             |
| `chatgptServiceTier`          | `"auto"` | 全局默认：`auto`（不发 service_tier）/ `fast`（=priority，官方别名归一）/ `flex` |

版本号优先级：手动覆写 > Mikiko 远端配置 `codex.clientVersion` > 内置 fallback `0.146.0`；`client_version` query 取整版本（官方 `client_version_to_whole`）。

**每会话/每模型覆写（P1）**：`modelSelection.options` 目前为 `{reasoningLevel}`（`packages/shared/src/model-selection.ts:8-13`，strict）；扩展 `serviceTier?: "auto"|"fast"|"flex"` 与 reasoningLevel 同机制走通（picker 值编码、Registry optionSpecs（模型规则从 manifest 的 `service_tiers/default_service_tier` 生成）、CLI 请求组装读 options.serviceTier 注入 body）。v1 先落全局默认（改动面 6 层，P1 单独 PR），manifest 元数据在 v1 目录规则中预留字段。

## 9. UI 改动

### 9.1 模型设置「ChatGPT」分类（需求 1）

- `ModelProviderNavGroupId` 加 `"chatgpt"` 分组；数据源 `chatgptAccountService.getAccounts()` 脱敏视图。
- 账号行：ChatGPT 图标（`provider-icons/model-provider-chatgpt.svg` + `ProviderLogo`/logo key）+ **名称 = displayName ?? 邮箱，换行小字邮箱**（需求确认 5）。
- `ProviderTemplatePicker` 新分组「ChatGPT」+ 单卡「ChatGPT OAuth」。

### 9.2 账号详情页（需求 3）

对齐智谱 `CodingPlanStatusPanel` 布局：头部（名称 + 邮箱小字 + plan 徽标 + 状态[含 rate-limited 倒计时]）+ 刷新 icon；订阅信息（类型/到期/额度窗口卡片 5h/7d/其他/`image_gen`）；剩余额度（credits.balance）；剩余重置次数（次数 + 每张卡过期时间）+ 行内「重置」按钮；操作区 `刷新令牌` / `退出登录`（确认后 revoke + 删记录）；auth-error 时主按钮变 `重新授权`。

**模型列表管理（2026-10-12 验收补充，需求对齐智谱）**：模型区复用 `ProviderModelsSection`（ModelProviderSection 分流处传入该 provider 的 models 视图与 personal 写入回调）：同步模型（builtin source）支持 编辑配置/启用/禁用/测试、**不显示删除**；手动添加（personal）模型另有删除入口；排序走 personal modelOrder；添加走模型元数据对话框。刷新沿用账号「刷新账号信息」（manifest 拉取 + revision bump → registry 推送，全窗口生效）。facade `#modelMembership` 从 registry resolvedProviders 取 `inheritedModelIds`，动态 provider 的 builtin slugs 天然进入成员校验，personal 层写入无需 host 改造。

### 9.3 异常展示（需求 8）

账号列表行与详情页状态徽标 + 原因文案（i18n 映射：invalid_grant/token_invalidated/revoked/misalignment/usage-limit 等，未识别 code 原样展示）。

### 9.4 会话模型选择器（需求 5）

`buildRegistryModelSelectGroups` 已按 provider 分组；chatgpt account provider 组标签 = **displayName ?? 邮箱**，重名时附邮箱前缀消歧；子项为模型。选择/发起请求走既有 `custom:{providerId}:{modelId}` 编码。

**Composer trigger 短名（2026-10-12 验收补充）**：`resolveV4ModelTriggerDisplay`/`formatProviderModelLabel` 对 chatgpt 账号 provider（`isChatGPTAccountProviderId`）与 zai/bigmodel family 同待遇——trigger 只显示模型名，不拼 provider 前缀（会话恢复与新建一致）。

### 9.5 左下角账户菜单（需求 4）

`WorkspaceSidebarFooter` 新增 ChatGPT 区块：各账号（displayName ?? 邮箱）点击 → 设置-模型设置-ChatGPT；无账号显示添加入口；异常标红。

### 9.6 上下文统计（需求 7）

当前模型为 chatgpt account provider 时旁侧展示 `ChatGPTContextUsage`（镜像 `CodingPlanContextUsage`）：5h/7d 剩余 + 重置时间（数据即 usage 快照，被动头更新保活）；有可用重置次数时显示重置按钮 → `resetQuota` → broadcastService 广播全窗口刷新（沿用 `codingPlanQuotaResetUiBySource` 模式）；consume 幂等键 + 失败提示「重置次数已变化」并重拉。

## 10. Mikiko 远端配置：Codex 版本号维护（需求 6.1）

- `packages/mikiko-cloud/src/worker.ts`：`ClientConfigs` 加 `codex: { clientVersion: string }`；默认 `0.162.1`（fail-open）；admin 写入口校验 `^\d+\.\d+\.\d+$`。KV `client-configs`。
- 客户端 `mikikoClientConfigService`：payload schema 加字段 + `getCodexClientConfig()`；§7.2 header builder 与 §5 models `client_version` 消费。
- 版本升级发布：改 worker 默认值或 admin 改 KV 即时生效（客户端 1h TTL + 手动刷新兜底）。
- **自动同步（2026-10-12 实测补充）**：`client_version` 是 manifest 内容协商键——`0.146.0` 只回 gpt-5.6 系 6 个 slug，`0.162.1` 回 10 个（含 gpt-6.1-sol/gpt-6-astra/gpt-6-sol/gpt-6-luna）。worker 加 `scheduled`（cron `0 */6 * * *`）从 GitHub `api.github.com/repos/openai/codex/releases?per_page=30` 取 **tag 前缀 `rust-v` 且非 prerelease** 的最新稳定版，校验 `^\d+\.\d+\.\d+$` 后写入 KV（对齐 sub2api `OpenAICodexVersionSyncService`：同步失败保留旧值 fail-open；admin 手写值不被覆盖——同步仅当 KV 无值或值为同步来源写入时更新）。
- 新模型 slug 的 `context_window` 等配置由 seed `modelConfigRules.modelRules` 的 `modelMatch` 正则覆盖（`.*gpt-6…` 同 `.*gpt-5.6…` 形态），随发布同步远端 KV。

## 11. 协议与类型改动清单

- `packages/shared/src/chatgpt-account.ts`（新）：记录/快照/视图类型、PKCE/JWT claims 解析、身份头 builder（含版本优先级）、CF cookie 白名单谓词、usage 窗口归一化、429 头族解析——全部纯函数。
- `packages/shared/src/oauth.ts`：`CHATGPT_PROVIDER_ID` 常量（开放式 union 不改）；不进 zai/bigmodel 互斥域。
- `packages/shared/src/model-provider-family.ts`：`"chatgpt"` family + spec。
- `packages/shared/src/channels.ts`：`ServiceChannels.ChatGPTAccount = "chatgpt-account"`。
- `packages/shared/src/account-provider-state.ts`：**不扩枚举**。评估结论（需求确认 4）：`credential-failed` 对 CLI Registry 只是二元门禁（available 与否），细分价值低；扩 `auth-invalid` 会引入与 `credential-failed` 语义重叠的近邻类型并增加协议两侧同步成本。精确原因由 ChatGPTAccountRecord.status.reason（服务私有字段）承载，UI 从服务视图取。
- `packages/shared/src/zcode-protocol/index.ts`：`zcodeProviderAccountAccessSchema` / `zcodeAccountAccessSchema` 加 `{type:"chatgpt-account", accountId, entitled}`；新增 CLI→host 通知 `provider/reportChatGPTRequestOutcome`（§7.5）。
- `packages/provider/src/config/provider-data-schema.ts`：group 加 `"chatgpt-family"`；access 加 `chatgpt-account`；`accountProviderConfigSchema`（schema.ts:26）对 chatgpt 条目放行 `api/group/logo/builtinModelIds/access`。
- `packages/provider/src/resolver.ts`：account 层过滤放宽——`access.type==="chatgpt-account"` 允许动态 id（前缀 `account:chatgpt:`，其余 id 仍须在 builtin）；`resolveProviderOrder` 纳入 chatgpt-family。
- `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts`：chatgpt 条目的 current 校验分支。

## 12. 独立 CLI 草案（P2，需求补充 3）

对齐 Codex CLI 能力面，仅做 OAuth 登录 + 正常请求：

- `zcode chatgpt login`：复用 host 同一套 PKCE/loopback 逻辑（逻辑在 shared 纯函数 + 独立可运行的 login runner），凭证写入**共享** credentials.json（`createSharedZCodeCredentialStore` 先例，key 同 `chatgpt-accounts`，onDidChange 跨进程通知已有）。
- 请求鉴权：`createStandaloneProviderRuntimeHeadersPort` 增加 chatgpt 分支（直读共享存储 + 本地惰性刷新，含 Permanent 缓存）。
- `zcode chatgpt logout`（revoke + 删记录）、`zcode chatgpt status`（邮箱/plan/用量摘要，对齐 `codex login status` 增强）。
- 排期在桌面端全量落地并稳定后。

## 13. 服务与装配（host）

- 新 `packages/services/src/chatgpt/`：
  - `chatgptOAuthClient.ts`：authorize URL/token exchange/refresh/revoke/claims 解析（纯逻辑）。
  - `chatgptAccountRepository.ts`：credentialService 读写 + 记录合并（RT 非空覆盖、Permanent 缓存比较凭证快照）。
  - `chatgptAccountService.ts`（RPC，channel `chatgpt-account`）：`getAccounts / startAuthorization / cancelAuthorization / refreshAccountInfo / refreshToken / resetQuota / logoutAccount / generateImage / editImage` + `onDidChangeAccounts / onAuthorizationCompleted / onAuthorizationFailed`。授权 listener 生命周期归它（单并发）。
  - `chatgptAccountRuntime.ts`：5min 定时扫描刷新（§6）+ `reportChatGPTRequestOutcome` 处理（§7.5）+ 被动 usage 落库 + 信封推送编排。
  - `chatgptAccountConfigSource.ts`：账号 → Registry 信封投影，接入 `node.ts` 既有 account 聚合与 `syncAccountProviderConfigToClient`。
  - `chatgptImagesClient.ts`（§7.6）+ `chatgptCloudflareCookieJar.ts`（§7.3，host 侧）。
- `accountProviderRequestAuthService` 加 chatgpt 分支（§7.4）。
- `node.ts` 装配：channel 注册、runtime 启动/销毁。
- 授权链接打开：host 返回 authUrl，renderer 走既有 `platform.openExternal`。

## 14. 安全

- token 只存加密 credentials.json；日志只记 accountId/邮箱域/错误码，不落 token 与完整邮箱。
- loopback listener 仅 127.0.0.1、单并发、10min 超时、state 校验后即关。
- 风险提醒（§4.1）为添加流程必经步骤，继续即视为接受。
- 合规提示：以 Codex CLI 客户端身份使用个人 ChatGPT 账号配额，存在风控/ToS 风险。

## 15. 测试与验收

- 单测：PKCE（base64url 官方口径）/claims 解析、RT 非空覆盖、Permanent 分类与短路、窗口归一化（5h/7d/单窗口/30D/image_gen）、429 头族与 body 解析、请求体改写、consume 幂等键、身份头 builder（版本优先级/FedRAMP/UA 开关）、CF cookie 白名单。
- 集成（host）：mock auth server 跑完整授权→enrich→落库；401 恢复→Permanent→auth-error→信封摘除→重授权恢复；429 usage_limit_reached→快照更新→rate-limited 状态；定时刷新触发窗口。
- 集成（CLI）：本地 mock SSE 验证 transport 改写、重试矩阵（5xx/流断/Retry-After）、401 本地恢复重试、CF jar 回放、outcome 上报。
- images client：mock 端点验证 generations/edits 请求与响应解析。
- Registry：动态 chatgpt provider 投影/摘除。
- 手动冒烟：真实账号授权（含 1455 被占报错）→ 详情页 → 会话选型发请求 → 用量面板被动更新 → 重置 → 401（改坏 token）自愈与摘除 → 生图接口冒烟。

## 16. 实施切分与决策记录

**PR 切分（7 个）**：

1. shared/provider 类型与 schema + seed-builtin 模板/模型规则 + mikiko-cloud codex 版本配置。
2. host：OAuth client + 账号仓储 + ChatGPTAccountService（授权/信息/重置/登出/revoke）。
3. host：requestAuth 分支 + ChatGPTAccountRuntime（定时刷新/401 恢复/错误矩阵/信封推送）。
4. CLI：chatgpt transport（改写/重试/CF jar/outcome 上报）+ registry 放宽。
5. UI：模型设置分组/详情页/添加流程（含风险提醒）+ 图标 + i18n。
6. UI：模型选择器分组、上下文统计+重置、左下角菜单、ChatGPT 设置页。
7. host：chatgptImagesClient（生图/编辑能力）。

**已裁定（本轮确认）**：client_id/端口取官方值，1455 被占即中断授权；Cloudflare 按官方 cookie jar（无需 TLS 指纹）；Fast/Flex v1 全局 + P1 每会话；异常原因复用 `credential-failed`（细分走服务视图 reason）；账户展示 displayName（wham/accounts/check）+ 副标题邮箱；刷新提前量官方 5 分钟 + 8 天兜底 + 保留后台定时器；新增 sub2api 导入添加路径（§4.3）。

**已定稿（原开放问题裁定）**：

1. UA terminalToken = `Mikiko/{appVersion}`（host 用运行时 app 版本，CLI 用打包版本常量）；若实测被风控，切换为固定官方样例串（单一常量，可热改）。
2. 订阅到期时间：保留 `GET /subscriptions?account_id=`（`active_until`）补充口径；**获取失败即隐藏该字段**，不重试不兜底。
3. `additional_rate_limits`（30D、`image_gen` 等窗口）在详情页**全部透出**为附加窗口卡片。

## 附录 A：核心契约（流程图 + 伪代码，实现以此为准）

### A.1 OAuth 与 JWT（shared 纯函数，host 使用）

```ts
// 全部 base64url-nopad，官方口径；不引入 hex
generatePkce(): { codeVerifier: string /*86 字符*/; codeChallenge: string }
  verifier = base64urlNoPad(crypto.randomBytes(64))
  challenge = base64urlNoPad(sha256(verifier /* ASCII */))
generateState(): string // base64urlNoPad(crypto.randomBytes(32))

buildChatGptAuthorizeUrl({ state, codeChallenge, port = 1455 }): string
  // GET {AUTHORIZE_URL}?response_type=code&client_id={CLIENT_ID}
  //   &redirect_uri=http://127.0.0.1:{port}/auth/callback
  //   &scope={SCOPE_LOGIN}&state=&code_challenge=&code_challenge_method=S256
  //   &id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs

parseIdTokenClaims(idToken): {
  email?: string            // 顶层 email ?? "https://api.openai.com/profile".email
  accountId?: string        // "https://api.openai.com/auth".chatgpt_account_id
  userId?: string           // chatgpt_user_id ?? user_id
  planType?: string         // chatgpt_plan_type
  isFedramp: boolean
  expiresAt?: string        // exp claim（校验 exp，不验签）
} | null                    // 解析失败 → null，流程报错
```

### A.2 Token 刷新与失败定级（host，对齐官方 AuthManager）

```
needsRefresh(account):
  account.credentials.accessTokenExpiresAt
    ? (expiresAt - now) <= 5min
    : (now - lastRefreshAt) > 8d

refreshWithLock(account):          // per-account in-flight 互斥
  if account.permanentRefreshFailure: throw AuthError(reason)   // 短路，不打接口
  POST TOKEN_URL (JSON):
    { grant_type: "refresh_token", client_id: account.credentials.clientId,
      refresh_token: account.credentials.refreshToken }         // 不带 scope
  成功: 仅非空字段覆盖（access/refresh/id_token）；
        accessTokenExpiresAt = 新 access_token JWT exp（解析失败则清空，走 8 天兜底）
        lastRefreshAt = now; 清空 permanentRefreshFailure
  失败: classifyRefreshFailure(error):
    permanent  ⇐ HTTP 401 || (400 + invalid_grant) ||
               code ∈ { refresh_token_expired, refresh_token_reused,
                        refresh_token_invalidated }
      → 写 permanentRefreshFailure{reason}；账号 status=auth-error；摘模型信封；广播
    transient ⇐ 5xx / 网络错误 → 保留旧 token（可用至 401），不置异常态
```

### A.3 请求期鉴权（host `resolveCurrent` chatgpt 分支）

```
resolveCurrent({ providerId, accountAccess: { type:"chatgpt-account", accountId } }):
  account = repo.get(accountId) ?? throw AccountRequestCredentialUnavailable
  if account.permanentRefreshFailure: throw AccountRequestCredentialUnavailable  // headersApplied:false
  if needsRefresh(account): await refreshWithLock(account)   // Permanent → 抛 Unavailable
  return requestAuth {
    apiKey: account.credentials.accessToken,
    headers: buildCodexIdentityHeaders(account, settings)
  }

buildCodexIdentityHeaders(account, settings):
  version = settings.codexVersionOverride
            ?? mikikoClientConfig.codex.clientVersion
            ?? CODEX_VERSION_FALLBACK
  uaSim ? {
    originator: "codex_cli_rs",
    "user-agent": `codex_cli_rs/${version} (${osType} ${osVersion}; ${arch}; Mikiko/${appVersion})`,
    version,
  } : { originator: "mikiko", "user-agent": `Mikiko/${appVersion}` }
  + { "chatgpt-account-id": account.accountId,
      accept: "text/event-stream",
      ...(account.profile.isFedramp ? { "x-openai-fedramp": "true" } : {}) }
```

### A.4 CLI transport（`chatgpt-responses-transport.ts`）

> **实现裁定（2026-10-12 实测）**：Node undici 默认 TLS ClientHello 指纹会被
> `/codex/responses` 以伪 401（`missing_end_user_auth`）拒绝；同一头体用 curl
> （系统 TLS 栈，HTTP/1.1 与 HTTP/2 均可）返回 200。因此 transport 默认走
> **curl 子进程通道**（`chatgpt-curl-fetch.ts`：`-D -` 头块解析 + stdout 流式 body，
> `-N` 保 SSE 不缓冲，字符串 body 自动补 `content-type: application/json`，
> AbortSignal 可中断；无 curl 环境回退 undici fetch）。Authorization 由 AI SDK 从
> requestAuth.apiKey 注入；`session-id/thread-id/x-client-request-id` 经实测非必需
> （发送与否均 200），v1 不发送。401 轮内重试（A.4 原伪代码的本地恢复）降级为
> 「上报后 host 强制刷新、下一轮自愈」，不在 fetch 内重试。

```ts
async function chatgptResponsesFetch(
  url,
  init,
  ctx: {
    sessionId: string;
    accountAccess;
    serviceTier: "auto" | "fast" | "flex";
    refreshAuth: () => Promise<RequestAuth>; // 触发 host 侧刷新并返回新 headers
    reportOutcome: (o: ChatGPTRequestOutcome) => void; // §7.5 通知
  },
): Promise<Response> {
  let body = transformResponsesBody(init.body, ctx);
  let headers = mergeHeaders(init.headers) + cfCookieJar.cookieHeader("chatgpt.com");
  let res = await fetch(url, { ...init, body, headers });

  if (res.status === 401 && !recovered) {
    // 官方 401 本地恢复：重取鉴权重试一次
    const fresh = await ctx.refreshAuth();
    res = await fetch(url, { ...init, body, headers: merge(fresh.headers) + cfCookies });
    recovered = true;
  }
  cfCookieJar.store("chatgpt.com", res.headers.getSetCookie());
  reportUsageHeadersThrottled(res); // 30s 节流

  if ([401, 402, 403].includes(res.status)) {
    const detail = await readErrorBody(res); // code/detail/message，CF HTML 识别
    if (isCloudflareHtml(res)) return res; // 403 CF 豁免：按网络错误向上抛
    reportOutcome({
      kind: "auth-error",
      providerId,
      status: res.status,
      errorCode: detail.code,
      message: detail.detail,
    });
  }
  if (res.status === 429)
    reportOutcome({
      kind: "usage",
      providerId,
      usageLimit: parseUsageLimitBody(bodyText),
      headers: parseRateLimitHeaders(res),
    });
  return res;
}

function transformResponsesBody(body, ctx) {
  b = JSON.parse(body);
  b.store = false;
  b.stream = true;
  delete b.max_output_tokens |
    max_completion_tokens |
    temperature |
    top_p |
    frequency_penalty |
    presence_penalty |
    user |
    metadata |
    stream_options |
    truncation |
    stop_sequences;
  if (typeof b.input === "string") b.input = [{ type: "message", role: "user", content: b.input }];
  if (b.reasoning) {
    b.include = ["reasoning.encrypted_content"];
    if (b.reasoning.effort === "minimal") b.reasoning.effort = "none";
  }
  b.service_tier =
    ctx.serviceTier === "auto"
      ? delete b.service_tier
      : ctx.serviceTier === "fast"
        ? "priority"
        : "flex";
  b.prompt_cache_key ??= ctx.sessionId;
  return JSON.stringify(b);
}
```

重试参数（官方对齐，transport 层实现）：5xx/408/网络错误重试 4 次、200ms×2ⁿ、jitter 0.9–1.1、尊重 `Retry-After`；流断重连 5 次；流空闲 300s；**429 不自动重试**。

### A.5 账号 → Registry 信封投影（host）

```
projectChatGPTAccountEnvelope(accounts, builtinCatalog):
  providers = {}; states = {}
  for account of accounts:
    id = `account:chatgpt:${account.accountId}`
    if account.status.state === "auth-error": continue        // 摘除（不出现在信封）
    slugs = (account.models?.slugs ?? []) ∩ builtinCatalog.chatgptKnownSlugs
    if slugs.isEmpty: continue                                 // 无可执行模型不发布
    providers[id] = {
      group: "chatgpt-family",
      access: { type: "chatgpt-account", accountId, entitled: true },
      api: { type: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
      logo: { type: "builtin", key: "chatgpt" },
      builtinModelIds: slugs,
    }
    states[id] = { availability: "available", entitled: true, current: true }
  return { providers, states }
// 触发时机：onDidChangeAccounts / 模型列表刷新 / 目录（builtin）revision 变化
```

### A.6 sub2api 导出解析（shared 纯函数）

```ts
parseSub2ApiAccountExport(input: unknown): {
  accounts: Array<{
    accountId: string        // credentials.chatgpt_account_id，缺失 → skip
    email: string            // credentials.email ?? id_token email ?? ""
    accessToken?: string     // 允许缺失（可用 refreshToken 刷新补齐）
    refreshToken: string     // 必需，缺失 → skip
    idToken?: string
    clientId: string         // credentials.client_id ?? 官方值
    accessTokenExpiresAt?: string   // access_token JWT exp ?? credentials.expires_at
    planType?: string        // credentials.plan_type
  }>
  skipped: Array<{ name?: string; email?: string; reason: string }>
}
// 过滤：accounts[].platform === "openai" && type === "oauth"
// 忽略：proxies、extra、model_mapping、concurrency/priority/rate_multiplier/auto_pause_on_expired/name
```

## 17. 实现状态与实测记录（2026-10-12）

已落地范围：PR1-7 全部（shared 纯函数/协议、provider 动态账号、host 服务栈与信封合并源、
CLI transport、设置页与添加流程、模型选择器/侧栏/ChatGPT 设置页、生图客户端）。

**关键实测结论（真实账号端到端冒烟 SMOKE_OK）**：

1. sub2api 导出导入 → wham 补全（7d 用量 7%、重置次数 2、模型清单 3 个）→ `/codex/responses`
   真实请求 200（SSE），模型回复正常（usage in=13/out=5），限流头（active-limit/credits）被动上报工作。
2. **TLS 指纹墙（重要偏差）**：Node undici 默认 TLS ClientHello 被 `/codex/responses` 以伪 401
   （`missing_end_user_auth`）拒绝；同头体 curl（系统 TLS）HTTP/1.1 与 HTTP/2 均 200。
   → transport 默认走 **curl 子进程通道**（`chatgpt-curl-fetch.ts`，流式 SSE、可中断、
   字符串 body 自动补 content-type、无 curl 回退 undici）。`session-id/thread-id/
x-client-request-id` 实测非必需，v1 不发送。
3. 401 轮内重试（§A.4 本地恢复）降级为「上报后 host 强制刷新、下一轮自愈」。
4. Authorization 由 AI SDK 从 `requestAuth.apiKey` 注入；`service_tier` 经私有载体头
   `x-mikiko-chatgpt-service-tier` 随 requestAuth 下发，transport 消费后剥离并写入请求体。
5. wham 端点（usage/credits/models）undici 直连可用，host 侧无需 curl 通道。
6. 已知小项：`wham/accounts/check` 对 Pro 账号未返回 `name/plan_type`（详情页名称回落邮箱、
   plan 来自导入/JWT），待后续观察上游口径；seed 新增模型规则需随发布流程同步到远端 KV。

**测试**：shared 纯函数 16、CLI transport/curl 通道 9、host 集成 6 全绿；门禁
typecheck/lint/fmt/architecture/verify 全过；adapters/shared/provider/services dist、
bundled agent CLI、desktop out 均已重建并重启 dev app。

### 17.1 桌面 CDP E2E 实测（2026-10-12，dev app + 真实账号）

- **UI 全链路（17 项 PASS）**：设置 → 模型设置 → 添加供应商 → ChatGPT OAuth 卡片 →
  风险弹窗（降智/接受风险文案完整）→ 接受后浏览器授权/导入两入口 → 取消关闭；
  ChatGPT 设置分区（UA 模拟开关默认开、服务档位选择器）渲染正常；全程 vite 错误浮层为 0。
- **账号态（RPC 注入真实账号后）**：供应商导航出现 `chatgpt-account:{id}` 条目（邮箱显示）；
  详情页完整渲染订阅（pro）/credits 余额/重置次数（含过期时间）/7d 窗口（88%）/3 个模型；
  「刷新账号信息」实测拉取成功（updatedAt 与 resetAfterSeconds 实时变化）。
- **会话请求（真实请求）**：模型选择器含 sol/terra/luna；选中 luna 后发送
  "Reply with exactly: pong"，assistant 回复 "pong"——OAuth token 经 curl 通道请求
  `/codex/responses` 成功，UI 正常渲染回复。
- **E2E 发现并修复**：
  1. credits 余额原始字符串 `62500.0000000000` 直出 → 新增
     `formatChatGPTCreditsBalance`（shared）格式化显示为 `62500`（含单测）。
  2. spec §9.6 会话内剩余额度组件当时漏实现 → 补 `ChatGPTContextUsage`
     （当前模型为 chatgpt 账号 provider 时在 ChatContextUsage 旁侧展示 5h/7d 剩余 +
     credits + 重置按钮；数据经 `onDidChangeAccounts` 事件天然跨窗口刷新）。
     组件级自动化受 CDP 对受控模型菜单驱动的限制未能截屏，**待人工验收视觉**。
- **上游行为确认（非 bug）**：wham/usage 对该 Pro 账号实时响应仅含 7d 单窗口
  （无 5h），UI 按数据正确渲染唯一窗口。
- **CDP 驱动经验**：Lexical 编辑器输入需 selection + `ClipboardEvent("paste")` 派发
  （`Input.insertText`/`execCommand` 均不触发 beforeinput）；模型菜单为受控
  DropdownMenu，模拟 click 不打开（源码注释已声明，走 `openRequestKey` 快捷键路径）。

### 17.2 登录链路代理与可观测性修复（2026-10-17 客户案例）

- 现象：浏览器授权回调页（127.0.0.1:1455）显示「已登录」，客户端提示添加失败
  （1.1.2 / f0ca034d）。
- 根因：回调页在 code→token 兑换前就返回成功页；而兑换/刷新/revoke 与 wham backend
  请求当时用裸 `globalThis.fetch` 直连，既不走设置页 httpProxy 也不读系统代理——浏览器
  经系统代理完成授权，host 直连 auth.openai.com 失败。客户日志时间线
  （2026-10-17）：17:13:09 `startAuthorization OK` → 17:13:24 `cancelAuthorization`，
  期间无任何服务端错误日志（失败路径零日志）。
- 修复：node.ts 装配处对 backendClient / runtime / accountService 三处统一注入与
  NodeApiClient 共享的 `hostApiNetworkTransport.fetch`；`exchangeChatGPTCode` 网络
  错误包装为 `transient/network`；授权失败 catch 补 `warn` 日志；网络错误事件文案
  指引「设置 → 常规 → HTTP 代理」。
- 语义：受限网络客户需在设置页显式配置 HTTP 代理（或系统 TUN 模式全局接管）才能
  完成登录；sub2api 导入（refresh）与账号 enrich 同链路自动受益。
