# Mikiko ID（KeyCloak）全线对接与相关改造技术方案

> 状态：待评审（评审通过后按 §12 实施顺序执行；各部分落地时同步更新对应 spec）· 2026-10-20（rev2：新增 G/H/I 三项复核与方案；A 部分按「彻底移除 MikikoCC 账密」修订）
> 覆盖范围：MikikoCC 登录接入 Mikiko ID（KeyCloak OIDC）+ 本轮 6 项问题修复/需求实现 + 追加 4 项（凭证续期 / 引导迁移窗口 bug / 首登后模型列表为空 / MikikoCC 账密彻底移除）。
> 来源文档（外部仓库）：
> - KeyCloak 侧：`mikiko.ai` 仓库 `docs/PROMPT-CODE-KEYCLOAK.md`（临时 v0）
> - sub2api 侧：`sub2api` 仓库 `docs/oidc-login-mikiko-app.md`（临时，2026-10-19）
> 契约已对照 sub2api 后端源码（`backend/internal/handler/auth_oidc_oauth.go` 等）核实；6 项问题已逐一对照本仓库源码复核，各 Part 开头给出复核结论。
> **本次对接走线上 KeyCloak（`https://oauth.mikiko.ai`，realm `mikiko`），不对接本地实例。** 联调凭据见 `/Users/fatballfish/Documents/Projects/OpsProjects/KeyCloak/.env`（仅供联调，不写入任何仓库与文档）。

## 0. 总览与依赖关系

| Part | 内容 | 涉及仓库/模块 | 前置 |
| --- | --- | --- | --- |
| A | MikikoCC 登录切换 KeyCloak OIDC（token-exchange 链路，**彻底移除账密**） | ZCode（services/ui）+ sub2api + KeyCloak 运维 | sub2api allowlist、KeyCloak client 切 Public |
| B | 新建会话页工作树/基线分支长名展示错位修复 | ZCode（ui） | 无，可立即做 |
| C | 帮助菜单「提交漏洞/给产品提需求」纠偏 | ZCode（ui）+ mikiko-cloud | C-b 依赖 D 的产品需求模块 |
| D | mikiko-cloud 后台重构（脚手架 + Tab 化 + 工单抽屉/列表操作 + 产品需求模块） | mikiko-cloud（packages/mikiko-cloud） | 无 |
| E | Mikiko ID 作为主账号：远控设备注册 + remote.mikiko.ai OIDC 登录直连 | ZCode（relay-server/desktop/web）+ KeyCloak 运维 | A、新 client `mikiko_remote` |
| F | 反馈/需求记录账户化与本地记录迁移同步 | ZCode（services/ui）+ mikiko-cloud | A、D 的 migration 0002 |
| G | 凭证生命周期：MikikoCC 平台 token 与 KeyCloak OIDC 凭证的持续续期（含 token 轮换不落盘存量缺陷修复） | ZCode（services） | A（OIDC 部分）；平台 token 续期可先行 |
| H | 三步引导勾选导入后迁移窗口未弹出（首启路径 bug） | ZCode（ui） | 无，可立即做 |
| I | 首登（欢迎页）后新建会话页模型列表为空 | ZCode（services/ui） | 无，可立即做 |

```text
B（独立）──┐
C-a 隐藏漏洞菜单（独立）──┤
D（独立，含后端补齐）──┼─▶ C-b 需求模块 UI ──▶ 收尾
H（独立）──┤
I（独立，可与 G 平台 token 部分同批）──┤
A（OIDC 登录，含账密移除）──┬─▶ G 的 OIDC 凭证续期部分
               ├─▶ E（远控 OIDC 直连，另需 KeyCloak 建 mikiko_remote client）
               └─▶ F（反馈账户化，migration 与 D 合并为 0002）
```

---

# Part A. MikikoCC 登录接入 Mikiko ID（KeyCloak OIDC）

## A.1 背景与范围

MikikoCC 是内置中转站站点（`kind === "mikikocc"`，面板 `https://mikiko.cc`、网关 `https://api.mikiko.cc`），当前与用户自建 sub2api 站点共用账密登录：`POST /api/v1/auth/login`（+ Turnstile / 2FA 分支），token 存 `<dataRoot>/v2/sub2api.json` 的 `StoredAccount`。

本 Part 将 **MikikoCC 站点的登录方式切换为 KeyCloak OIDC 授权登录**，登录产物仍是 MikikoCC 平台自身 token pair，下游（密钥同步、个人供应商投影、用量）零改动。

**范围硬边界（用户明确要求）：**

- ✅ 仅 `kind === "mikikocc"` 的内置站点切换为 OIDC 登录，**并彻底移除项目内 MikikoCC 的账密登录逻辑**（含首登欢迎页入口、设置页入口、Turnstile/2FA 分支，见 A.6.4）；
- ✅ 客户端**首次登录的初始登录选项**（WelcomeScreen `loginMode === "mikikocc"`）同样切换为 OIDC，全入口一致；
- ❌ `kind === "sub2api"` 的用户自建站点保持账密登录、Turnstile、2FA 全链路不动；
- ❌ 不改智谱（zai/bigmodel）OAuth、ChatGPT OAuth 的既有行为。

**存量已登录账号处理（rev3 裁定）**：不做会话保留。新版本首次启动做**一次性升级迁移（A.9）**——检测到历史账密登录的 MikikoCC 账号即清除账号态并级联清理其供应商/密钥/模型配置，UI 引导以 OIDC 重新登录、重新初始化模型列表。

## A.2 方案选型（结论先行）

| 候选链路 | 出处 | 取舍 | 理由 |
| --- | --- | --- | --- |
| **A. App 独立 OIDC + token-exchange**（授权码 + PKCE → id_token → `POST /api/v1/auth/oauth/oidc/token-exchange` 换平台 token pair） | sub2api 文档 §2/§4.1 | **✅ 采用** | token-exchange 已在 sub2api 后端实现（已核实源码）；无需 WebView/JS bridge/ticket 交付契约；平台 token 与 KeyCloak 会话解耦 |
| B. 内嵌 WebView 走 CC 的 SSO + ticket 交付 | KeyCloak 文档 §4.3 形态 1 / §5 | ❌ 废弃 | v0 草案，ticket 契约从未定稿；token-exchange 已实际落地 |
| 回调形态：loopback 本地端口（RFC 8252） | KeyCloak 文档 §3.2 | **✅ 主通道** | 复用 ChatGPT OAuth 先例（`chatgptOAuthClient.ts`）；KeyCloak 回环端口通配；系统浏览器可复用 realm SSO Cookie 静默重登 |
| 回调形态：私有 scheme 深链 | KeyCloak 文档 §3.3 | ⏸ 暂不做 | 桌面端 loopback 基本总能成功；现有深链 `zcode://oauth/callback` 仅路由到智谱 oauthService（`useRootOAuthEffects.ts`）。列为后续可选扩展（§13） |

浏览器上下文用**系统默认浏览器**（`platform.openExternal`）：与 sub2api 文档 §3「系统浏览器共享 Cookie、内嵌 WebView 不共享」一致。

**KeyCloak client 定型：`mikiko_code` 切 Public + PKCE-only（无 client_secret）。** 两份文档安全清单一致建议；切换由运维完成。

**sub2api 侧前提：先实现「阶段二 allowlist」。** 已核实当前源码：`OIDCTokenExchange` 硬校验 id_token 的 `azp`（缺省取 `aud[0]`）必须等于平台主 OIDC Provider 配置的 `client_id`，文档 §6.1 的 `token_exchange_allowed_clients` **尚未实现**——`mikiko_code` 的 id_token 今天会被 `OAUTH_ID_TOKEN_INVALID: id_token audience mismatch` 拒绝。阶段一（复用平台主 client）不建议（需把主 client 降 Public，损害 Web 控制台安全属性）。

## A.3 目标链路（时序与所有权）

```text
Renderer(UI)            sub2apiService（sub2api.json 唯一所有者）      系统浏览器         KeyCloak                mikiko.cc
   │ ①startOIDCLogin("mikikocc")   │                                     │               oauth.mikiko.ai          (panel)
   ├──────────────────────────────▶│ kind 守卫（非 mikikocc 直接拒绝）        │                   │                     │
   │                               │ ②生成 state + nonce + PKCE(verifier/challenge)              │                     │
   │                               │ ③loopback 监听 127.0.0.1:0（随机端口）  │                   │                     │
   │◀── { authorizeUrl } ──────────┤                                     │                   │                     │
   │ ④platform.openExternal        │                                     │                   │                     │
   │───────────────────────────────────────────────────────────────────▶│ 授权（首登输账密；   │                     │
   │                               │                                     │  SSO Cookie 在则静默）│                  │
   │                               │◀── ⑤GET /callback?code&state ───────┤◀──── 302 ─────────│                     │
   │                               │ ⑥state 精确校验 → 返回本地成功页 → 关监听 │                │                     │
   │                               │ ⑦POST token 端点（code+verifier, 无 secret）──────────────▶│                     │
   │                               │◀── id_token / access_token / refresh_token ────────────────┤                     │
   │                               │ ⑧解码 id_token payload：nonce 一致 + 取 email/sub           │                     │
   │                               │ ⑨POST /api/v1/auth/oauth/oidc/token-exchange {id_token} ─────────────────────────▶│
   │                               │◀── {access_token, refresh_token, expires_in}（裸 JSON）─────────────────────────┤
   │                               │ ⑩GET /auth/me（email/余额）→ fetchKeys → syncProviders      │                     │
   │                               │ ⑪saveConfig 落盘 + onDidChange / onOIDCLoginCompleted 广播  │                     │
   │◀── ⑫登录完成，进入既有账号态 ───┤                                     │                   │                     │
```

所有权与事件顺序约定（对齐 architecture-governance 的 single owner / explicit time）：

- **sub2api.json 仍是唯一持久化事实**；完成续体（⑨–⑪）与 login/logout 一样走 `configWriteMethods` 写串行队列，不与余额轮询等在途写并发覆盖。
- **pending 授权会话单例**（对齐 ChatGPT `pendingAuthorization` 模式）；重复 `startOIDCLogin` 先取消旧会话。
- **幂等/一次性**：授权码一次性且约 60s 有效；`state` 不匹配直接 400 不进交换；回调监听 120s 超时作废本次 state/nonce/verifier（KeyCloak 文档 §3.2 口径）。

**KeyCloak token 持久化（本轮修订，服务 Part E/F）**：为支撑「Mikiko ID 作为主账号」（远控设备注册 Part E、反馈账户化 Part F 都需要以 KeyCloak `sub` 为用户唯一标识），登录时 scope 增加 `offline_access`，`StoredAccount` 新增：

```ts
oidc?: {
  sub: string;            // KeyCloak 全局用户唯一标识（用户账号唯一键）
  email?: string;         // 展示用
  credentialKey: string;  // 指向 credentialService 加密条目（固定键 "sub2api:mikikocc:oidc-refresh-token"）
}
```

**refresh token 加密存储（rev3 裁定，替代 rev2 的明文方案）**：KeyCloak offline refresh token 经 `credentialService`（加密凭据库）按 `credentialKey` 存取，`sub2api.json` 中**不出现任何明文 OIDC 凭据**；登出/换号/升级清理时删除对应凭据键。不落盘 KeyCloak 的 access_token/id_token（短时凭据用完即弃）。

## A.4 外部前提与配置清单（KeyCloak / sub2api / 联调）

| # | 事项 | 负责 | 说明 |
| --- | --- | --- | --- |
| 1 | `mikiko_code` 切 Public + 强制 PKCE S256，仅 Standard Flow；Direct Grant/Service Account 保持 OFF | 运维（KeyCloak） | 切换后 App 不携带 secret |
| 2 | `mikiko_code` Valid Redirect URIs 增加 `http://127.0.0.1:*` | 运维（KeyCloak） | 回环端口通配，支持随机端口 |
| 3 | sub2api 落地 `token_exchange_allowed_clients`（主 OIDC Provider 配置新增字段，仅管理员可改），受众校验放宽为 `azp/aud ∈ {主 client_id} ∪ allowed_clients`，登记 `mikiko_code` | sub2api 后端 | 现状硬校验主 client_id（已核实）；issuer/JWKS 验签、sub/email 校验逻辑保持不变 |
| 4 | KeyCloak realm 确认 `offline_access` scope 可用（offline session 策略：refresh token 生命周期足够长） | 运维 | Part E 依赖 |
| 5 | 新建 client `mikiko_remote`（Public + PKCE，Valid Redirect `https://remote.mikiko.ai/oidc/callback`） | 运维（KeyCloak） | Part E 的 remote.mikiko.ai 网页登录用 |
| 6 | 联调环境 = 线上 KeyCloak | 全部 | 凭据见 KeyCloak 运维仓 `.env`（不入库）；本地 dev 仅在需要时用环境变量覆盖（A.8），联调验收一律走线上 |

## A.5 契约规格（已对照 sub2api 源码核实）

### A.5.1 KeyCloak OIDC（授权码 + PKCE S256）

```text
线上 issuer:  https://oauth.mikiko.ai/realms/mikiko
授权端点:     {issuer}/protocol/openid-connect/auth
Token 端点:   {issuer}/protocol/openid-connect/token

GET 授权端点?
    client_id=mikiko_code
    &redirect_uri=http://127.0.0.1:{实际监听端口}/callback   ← 与 token 交换完全一致
    &response_type=code
    &scope=openid email profile offline_access
    &state=…（随机，回调精确匹配）
    &nonce=…（随机，解码 id_token payload 比对）
    &code_challenge=BASE64URL(SHA256(code_verifier))
    &code_challenge_method=S256

POST Token 端点（application/x-www-form-urlencoded）:
    grant_type=authorization_code & code=… & redirect_uri=…
    & client_id=mikiko_code & code_verifier=…
    （Public client：不带 client_secret）
```

- `code_verifier` 43–128 位随机串，仅在 service 进程内暂存；
- App 侧对 id_token 只做**解码 payload 校验 nonce / 提取 email 与 sub**，不做本地 JWKS 验签——验签由 token-exchange 端点强制完成（fail-close，已核实即使后台未开 `validate_id_token` 也会按 discovery 拉 JWKS 验签）；id_token 仅经 HTTPS 提交给 mikiko.cc，不落盘不打日志。

### A.5.2 token-exchange：`POST https://mikiko.cc/api/v1/auth/oauth/oidc/token-exchange`

- 请求体 `{"id_token": "…"}`；限流 20 次/分钟/IP（fail-close）。
- 响应为**裸 JSON，无 `{code,data}` 信封**（已核实 `writeOAuthTokenPairResponse` 直接 `c.JSON`）：`{access_token, refresh_token, expires_in, token_type}`。
- 平台侧行为：按 `(provider=oidc, issuer, sub)` 查绑定，命中且激活 → 直接签发；未命中 → 要求 `email_verified=true` 自动注册/绑定同邮箱账号；邮箱与既有绑定不一致 → `AUTH_IDENTITY_EMAIL_MISMATCH`。
- **实现注意**：该请求不能走现有 `panelRequest()`（按信封解析，裸 JSON 的 `code` 为 `undefined` 会被误判失败），OIDC 客户端需独立解析函数。

### A.5.3 各端点响应格式对照（实现口径）

| 端点 | 格式 | 现有代码口径 |
| --- | --- | --- |
| `POST /api/v1/auth/login`、`/login/2fa` | 信封 `{code:0, data:{…}}` | `panelRequest`，不变（sub2api 站点继续用） |
| `POST /api/v1/auth/refresh` | **信封**（已核实 `response.Success` 包装） | `refreshSiteToken` 现有解析正确，OIDC 登录后直接复用 |
| `POST /api/v1/auth/logout` | 信封 | 新增调用（A.7） |
| `POST /api/v1/auth/oauth/oidc/token-exchange` | **裸 JSON** | 新写独立解析 |
| `GET /api/v1/auth/me` 等面板接口 | 信封 | `panelRequestWithRefresh` 复用 |

### A.5.4 错误码与 UI 处理

| 错误 | 场景 | UI 文案方向 |
| --- | --- | --- |
| `OAUTH_ID_TOKEN_INVALID` | 验签失败 / 受众不匹配（allowlist 未配好、client 配错） | 「登录服务配置异常，请稍后重试」（errorCode 进 logger） |
| `OAUTH_EMAIL_NOT_VERIFIED` | 新身份且邮箱未验证 | 引导先在浏览器完成一次 Mikiko ID 首登（邮箱验证） |
| `USER_NOT_ACTIVE` / `login_blocked` 类 | 账号禁用 / 运行模式限制 | 「账号不可用，请联系客服」 |
| `AUTH_IDENTITY_EMAIL_MISMATCH` | 身份邮箱与既有绑定冲突 | 提示联系客服解绑 |
| 回调 `error=access_denied` 等 | 用户在 KeyCloak 侧拒绝/取消 | 静默回到登录按钮态 |
| state 不匹配 / 回调超时 / 授权取消 | CSRF 防护、120s 超时、用户取消 | 「授权已取消/超时，请重试」 |
| 网络错误（KeyCloak 或 mikiko.cc 不可达） | 交换失败 | 「网络错误，请检查网络或代理后重试」（对齐 ChatGPT 的 network 分类文案） |

## A.6 ZCode 侧改造设计

### A.6.1 模块与文件清单（受管模块：`services`、`ui`；`shared`、`desktop` 零改动）

| 文件 | 改动 |
| --- | --- |
| `packages/services/src/sub2api/sub2apiOidcClient.ts` | **新增**。KeyCloak OIDC 纯 IO 适配层：常量（issuer/client/scope/回调 path/超时）、`generateOidcPkce/state/nonce`、`buildAuthorizeUrl`、`exchangeCode`（token 端点，form-encoded，无 secret）、`exchangeIdTokenForPlatformTokens`（token-exchange，裸 JSON 解析 + A.5.4 错误映射）、`parseIdTokenPayload`（解码，校验 nonce/iss，提取 email/sub）、`refreshOidcAccessToken`（refresh_token grant，供 Part E 使用）。请求出口支持注入 `request`（对齐 chatgptOAuthClient，生产经 host 网络 transport 使 httpProxy/CA 生效） |
| `packages/services/src/oauth/loopbackCallbackListener.ts` | **新增（自 chatgptOAuthClient 提取的通用件）**。`startLoopbackOAuthListener({expectedState, onCode, port, path, timeoutMs, successHtml})`：state 精确校验、成功页、超时/取消/端口占用语义。chatgptOAuthClient 改为以固定端口 1455 复用它（行为不变，回归其既有测试） |
| `packages/services/src/sub2api/sub2api.ts` | 接口扩展（A.6.2） |
| `packages/services/src/sub2api/sub2apiService.ts` | 编排实现（A.6.3）+ `configWriteMethods` 增补 + logout 撤销（A.7）+ `StoredAccount.oidc` 字段 |
| `packages/ui/src/settings/Sub2ApiLoginPanel.tsx` | 按 `method` prop 分流：mikikocc → OIDC 按钮/等待态/错误态；sub2api → 现有账密表单原样 |
| `packages/ui/src/WelcomeSub2ApiLogin.tsx`、`packages/ui/src/settings/Sub2ApiSection.tsx` | 传 `method`（按站点 kind）；其余自动生效 |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | 新增文案 key |
| `packages/shared` / `packages/desktop` | **不改**（服务描述符已有事件机制，无新 channel、无协议改动、不动深链） |

### A.6.2 `ISub2ApiService` 接口变更

```ts
/** 发起 MikikoCC 的 Mikiko ID（KeyCloak OIDC）登录。仅 kind=mikikocc；
 *  返回 authorizeUrl 由 UI 用系统浏览器打开；结果经事件回传。 */
startOIDCLogin(siteId: string): Promise<{ authorizeUrl: string }>;
cancelOIDCLogin(siteId: string): Promise<void>;
readonly onOIDCLoginCompleted: Event<{ siteId: string; state: Sub2ApiSiteState; syncedKeyCount: number }>;
readonly onOIDCLoginFailed: Event<{ siteId: string; message: string; errorCode?: string }>;
/** 供远控等模块读取 MikikoCC 的 OIDC 身份（Part E）。 */
getOIDCIdentity(siteId: string): Promise<{ sub: string; email?: string } | null>;
/** 用离线 refresh token 换短时 KeyCloak access token（Part E 设备认领用）。 */
getOIDCAccessToken(siteId: string): Promise<string | null>;
```

- `login` / `loginWith2FA` **保留但对 `kind === "mikikocc"` 增加硬守卫（直接抛「MikikoCC 请使用 Mikiko ID 登录」）**：sub2api 站点继续使用这两个方法；这是「彻底移除 MikikoCC 账密逻辑」的服务端兜底（UI 移除入口之外，防止任何残留调用路径）。`getPublicSettings` 同样仅服务 sub2api 站点的 Turnstile 判定，mikikocc 调用不再触发 UI Turnstile 分支。

### A.6.3 服务编排（sub2apiService 内部）

```text
startOIDCLogin(siteId):
  1. findSite → kind !== "mikikocc" → throw（硬守卫）
  2. 取消既有 pending 会话
  3. state/nonce/PKCE 生成；loopback 监听 127.0.0.1:0 → 取实际端口拼 redirect_uri
  4. 返回 { authorizeUrl }；完成/失败经 done promise 驱动

完成续体（监听 onCode，加入 configWriteMethods 的内部方法，由 serializedService 队列化）:
  5. exchangeCode → KeyCloak id_token / refresh_token
  6. parseIdTokenPayload：nonce 不一致 → 整体失败（防重放）
  7. exchangeIdTokenForPlatformTokens → 平台 token pair（裸 JSON）
  8. site.account = { email: id_token.email, accessToken, refreshToken,
                      expiresAt: now + expires_in*1000,
                      oidc: { sub, refreshToken: keycloakRefreshToken, lastRefreshedAt } }
  9. /auth/me 补全余额 → fetchGroups + fetchAndStoreKeys → saveConfig → syncProviders
     （复用 login 的后置序列；同步失败不阻断登录返回，同既有语义）
 10. onOIDCLoginCompleted 广播；失败路径 onOIDCLoginFailed（含 A.5.4 errorCode）
```

- **请求出口**：KeyCloak 与 token-exchange 的 fetch 均经注入的 host 网络 transport（与 chatgptAccountService 相同的 `request` 注入点），使「设置 → HTTP 代理」对授权链路生效（2026-10-17 ChatGPT 客户案例同款坑）。
- **服务日志**：`createServiceLogger("sub2api")` 记 info（授权开始/完成/失败、errorCode、siteId）与 debug（发现文档元信息），不落任何 token/verifier 明文。

### A.6.4 UI 改造（全入口 OIDC，无账密回退）

- `Sub2ApiLoginPanel` 新增 `method: "oidc" | "password"`（调用方按站点 kind 决定）：
  - `oidc`（mikikocc，**唯一登录方式**）：单按钮「使用 Mikiko ID 登录」→ `startOIDCLogin` → `platform.openExternal(authorizeUrl)` → 等待态（提示「在浏览器中完成登录…」+「取消」调 `cancelOIDCLogin`）；订阅 `onOIDCLoginCompleted/Failed` 收敛状态。无 Turnstile、无 2FA 分支、**无「使用账号密码登录」折叠入口**（用户裁定彻底移除，不留过渡回退）。
  - `password`（sub2api）：现有表单逐字保留（邮箱/密码/Turnstile/2FA）。
- **首登欢迎页**（WelcomeScreen `loginMode === "mikikocc"` → `WelcomeSub2ApiLogin` variant）与**设置页**（`Sub2ApiSection`）都经同一 panel 自动切换，初始登录选项与设置入口行为一致。
- 清理随账密入口一并失效的 mikikocc 专属 i18n key（如 Turnstile/2FA 相关仅 sub2api 保留），两个 locale 同步。

### A.6.5 安全设计

- `code_verifier`/`state`/`nonce` 仅存内存 pending 会话，回调即焚；超时/取消/完成均清空。
- loopback 监听只绑 `127.0.0.1`，处理完立即关闭；随机端口降低占用与外部探测面。
- id_token 不落盘、不进日志、不经 URL 传递。

### A.6.6 登出与会话生命周期

| 场景 | 行为 |
| --- | --- |
| 退出登录（mikikocc，OIDC 账号） | 现有级联清理不动；**新增**：清账号态前 best-effort `POST /api/v1/auth/logout {refresh_token}` 撤销平台 refresh token，失败仅 warn 不阻塞。仅对 OIDC 登录的 mikikocc 生效。同时清除 `StoredAccount.oidc`（远控设备绑定随之失效，属预期——见 Part E 的解绑语义） |
| KeyCloak realm 登出（end_session） | **默认不联动**（§13 决策点 1） |
| access_token 过期 | 既有 `panelRequestWithRefresh` 反应式 401 → `/auth/refresh` → 重放；refresh 轮换后覆盖存储 |
| 平台 refresh 失效 | 401 且刷新失败 → UI 判定未登录态，引导重新 OIDC 登录（浏览器 SSO Cookie 仍在，大概率静默秒过） |
| KeyCloak offline refresh 失效（用户在 Mikiko ID 控制台撤销会话） | Part E 的设备认领降级为未认领；下次 MikikoCC 重登恢复。提示不阻塞 |
| 账号切换 | 重新走 OIDC；realm Cookie 会静默拿到上一账号，如需强制选号加 `prompt=login`——首版不加，列为增强 |

### A.6.7 开发配置覆盖（仅本地 dev 用）

线上常量内置于 `sub2apiOidcClient.ts`；支持环境变量覆盖：

```text
ZCODE_MIKIKO_OIDC_ISSUER / ZCODE_MIKIKO_OIDC_CLIENT_ID / ZCODE_MIKIKOCC_PANEL_URL
```

读取位置在服务组装层（`node.ts` 既有 env 注入模式）。**联调验收一律走线上值。**

## A.7 错误路径与超时汇总

- 回调监听 120s 超时 → 作废 state/verifier，`onOIDCLoginFailed("授权超时")`；
- 用户关闭面板/窗口 → `cancelOIDCLogin` 关监听（未 settle 时 reject `cancelled`，不再 fire Failed）；
- 浏览器回调成功但交换/token-exchange 失败 → 本地成功页已返回浏览器，必须经 `onOIDCLoginFailed` 透出并落 warn 日志（含 errorCode，不含 token）——ChatGPT 2026-10-17 案例同款教训；
- 授权码过期（60s）→ 直接失败提示重试，不自动重发；
- loopback 端口绑定失败 → 随机端口下概率极低，失败即中断提示重试（不扫描重试端口）。

## A.8 测试与验收

单测（`packages/services/test/`，node:test）：

1. **oidc client**：authorize URL 参数完整性（PKCE S256/state/nonce/scope/redirect 与监听端口一致）；code 交换 form 体（无 client_secret）；token-exchange 裸 JSON 解析、信封误判防护；A.5.4 各 errorCode 映射；nonce 不一致拒绝；listener state 不匹配 400、超时、取消、成功页语义；offline refresh 交换。
2. **service 编排**：`startOIDCLogin` 对 `kind=sub2api` 站点抛错（范围守卫回归）；**`login`/`loginWith2FA` 对 `kind=mikikocc` 抛错（账密移除守卫回归）**；happy path → account 写入（含 `oidc.sub/refreshToken`）、keys 同步、syncProviders、广播、落盘；完成续体与并发 `getAccountDetail` 的写串行化（复用 `sub2apiConfigWriteRace.test.ts` 手法）；重复 start 取消旧会话；失败路径事件与日志。
3. **loopback 提取回归**：chatgpt 既有 listener 测试全绿（固定端口 1455 行为不变）。
4. **logout 撤销**：OIDC 账号 logout 调 `/auth/logout`（失败不阻塞级联清理）；sub2api 站点 logout 不发该请求。

E2E（交互改动必须有场景；**走线上 KeyCloak**）：冷启未登录首登、二次静默、无 Cookie 反例、取消/超时、sub2api 自建站点账密回归不变。

## A.9 存量账密账号升级迁移（rev3 裁定）

- **触发**：`loadConfig` 时检测 `kind === "mikikocc"` 且 `site.account` 存在且**无** `oidc` 字段（即历史账密登录态），且未执行过本迁移（config 增加 `mikikoccPasswordMigrationDone` 标记，幂等）。
- **动作**：复用 `logout` 的级联清理（`cascadeRemoveSiteProviders`：删该站点全部密钥供应商与模型配置、清 providerBindings/keyModels/activeKeyId/providerId/modelConfigs 前缀），清账号态；站点记录保留（内置不可删）。在写队列内执行一次，`saveConfig` 落盘 + 广播。
- **引导**：迁移后 `getSites` 的 mikikocc 站点为未登录态；设置页/欢迎页对 mikikocc 展示 OIDC 登录入口即完成引导（不额外弹窗）。用户重登后按现行规则全新同步模型列表。
- **测试**：迁移幂等（二次启动零动作）、清理范围与 logout 一致、sub2api 站点不受影响、迁移后 OIDC 登录全链路可用。

---

# Part B. 新建会话页工作树/基线分支长名展示错位（问题 1）

## B.1 复核结论：**已确认，根因定位**

截图复核：新建会话草稿页（问候语 + 工作位置选择器）在「现有工作树」锁定态下，**身份 chip 与 HEAD chip 内的长分支名（如 `fatballfish/rnd-55276-store-list-storage-2026101…`）没有任何宽度约束**，把 chip 撑破容器，「现有工作树」中文标签被挤成竖排，两枚 chip 高度错位。根因在 `packages/ui/src/v4/composer/DraftWorkLocation.tsx`：

1. **锁定态两枚只读 chip**（`DraftWorkLocation.tsx:118-139`）：`inline-flex h-7 …` 容器内，identity `<span className="font-mono text-ui-xs">` 与分支名 span **均无 `max-width`/`truncate`/`min-w-0`**；外层 `flex items-center gap-1`（118 行）无收缩约束，长名直接撑宽整行。
2. **非锁定态 existing-worktree 的分支 chip**（`DraftWorkLocation.tsx:170-185`）：同样无约束。
3. **new-worktree 的 RefPicker 触发器**（`DraftWorkLocation.tsx:373-381`）：`triggerLabel`（基线分支名）无上限，长名同样撑爆按钮。
4. 对照：弹层内的选项列表已正确截断（`min-w-0 flex-1 truncate`，304/437 行），问题只在触发器/展示 chip。

## B.2 修复方案：截断展示 + hover 气泡全名

统一规则（对齐用户建议与 DESIGN.md 既有交互）：

- **chip/触发器**：容器加 `min-w-0`；名称部分（`font-mono` span）加 `min-w-0 truncate` + 最大宽度上限 `max-w-[16rem]`（约 64 半角字符，可按视觉微调）；图标与「现有工作树」标签加 `shrink-0 whitespace-nowrap`；ChevronDown 保持 `shrink-0`。
- **hover 全名**：外层包 `ControlHintTooltip`（仓库既有组件，`packages/ui/src/ControlHintTooltip.tsx`，帮助菜单已在用），title = 完整分支名/工作树名。tooltip 不进 PopoverTrigger asChild（组件注释已记录该坑，沿用同样手法包在 chip 外层）。
- **两枚 chip 协同收缩**：外层 `flex` 容器加 `min-w-0`，两枚 chip 按 `flex-shrink` 比例收缩（标签固定的那枚优先保住标签，名称各自截断），保证同行不换行、等高对齐。
- 适用位置：锁定态身份 chip（119-123）、锁定态 HEAD chip（124-138）、非锁定态分支 chip（170-185）、RefPicker 触发器（373-381）。`LocationSelector` 触发器本身只显示固定文案（「现有工作树/新建工作树/本地」），无需处理。

## B.3 验收与 spec

- 视觉验收：构造 ≥80 字符分支名的工作树（锁定态 + 选择态 + 新建基线三种形态），chip 单行截断、尾缀 `…`、hover 出完整名、两枚 chip 等高、无标签竖排。
- E2E：按仓库规则补一条长名工作树的草稿页快照场景（沿用既有 e2e 流程）；回归既有 worktree E2E。
- spec 更新：`specs/desktop/worktrees.md`（展示规则补「长名截断 + tooltip」条目）。
- 改动文件仅 `DraftWorkLocation.tsx`（+i18n 无新增，tooltip 复用名称原文）。

---

# Part C. 帮助菜单「提交漏洞 / 给产品提需求」纠偏（问题 2）

## C.1 复核结论：**部分确认，有一处纠偏**

- **「提交漏洞」——确认**。`WorkspaceHelpMenuButton.tsx:114-127`：菜单项由 `useVulnerabilityReportUrl` 提供 URL（`clientConfigService` 快照的 `zsrcUrl`，即 z.ai 侧配置的官方漏洞提交页外链），点击 `platform.openExternal` 跳智谱官方页面。Mikiko 侧无对应实现。**处理：隐藏（删除菜单项）**。
- **「给产品提需求」——记忆有偏差，实际已走自建链路，但混流**。入口（`WorkspaceHelpMenuButton.tsx:128-131`）打开的是本地 `FeatureRequestDialog`（`packages/ui/src/feedback/FeatureRequestDialog.tsx`），以 `ticketType: "feature"`（138 行）经 `startSimplifiedFeedbackSubmission` → `IFeedbackService` → **mikiko-cloud** `POST /api/v1/feedback/tickets`（agent.mikiko.ai），不是智谱接口。真正的问题是：**服务端建单时把客户端 type 丢弃**（`mikiko-cloud/src/feedback.ts` createFeedbackTicket INSERT 中 `type` 恒为 NULL），需求与 Bug 混入同一工单流，后台无法区分筛选。**处理：按用户要求落成「产品需求」自建模块（与问题上报同级），依托 Part D 的 mikiko-cloud 改造实现**。

## C.2 方案

### C.2.a 隐藏「提交漏洞」+「产品文档」「用户社群」（rev3 裁定）

- **彻底清除「提交漏洞」**：删除 `WorkspaceHelpMenuButton.tsx:114-127` 菜单项、`useVulnerabilityReportUrl` hook 文件及 `ShieldAlertIcon` 引用；i18n key `workspaceHeader.help.reportVulnerability` 两个 locale 删除；`clientConfig.zsrcUrl` 解析链路（shared `clientConfig.ts` 的 `zsrc` 字段与 `zsrcSchema`）确认无其他消费方后一并删除（不影响现有功能——该 URL 仅有此菜单消费）。
- **隐藏「产品文档」「用户社群」**：两菜单项暂不渲染（实现与 `helpMenuActions.openProductDocs`、`platform.openCommunity` 保留），带注释说明「后续改为自实现链接后恢复」；i18n key 保留。

### C.2.b 「给产品提需求」升级为产品需求模块

- 客户端：`FeatureRequestDialog` 提交参数增加 `kind: "feature"`（工单 kind 字段见 Part D.4）；表单结构不变（需求描述/期望解决方案/联系方式），提交成功文案与入口不变——用户侧无感，数据落到新模块。
- 服务端：`POST /api/v1/feedback/tickets` 接受可选 `kind`（`bug`（默认）| `feature`），随 `owner_sub` 一起落库（Part D.4 migration）。
- 后台：产品需求 Tab（Part D.3），需求侧状态机首版复用工单状态枚举（§13 决策点 5）。
- spec 更新：`specs/mikiko-cloud/feedback-tickets.md`（补 kind/需求模块与「提交漏洞菜单下线」记录）。

---

# Part D. mikiko-cloud 后台重构（问题 3 + 问题 4）

## D.1 复核结论：**全部确认**

- 3a 确认：`public/admin.html` 是 1421 行单文件 vanilla 页面，「模型预置配置 / 功能配置 / 问题反馈工单」三个 `<h2>` 区块**纵向堆叠单页滚动**（admin.html:335-526），看工单要翻到最下面。
- 3b 确认：工单详情是页面内段显隐切换的内嵌 card（`#fb-detail-card`，admin.html:463-525），打开时列表仍在上方；评论编辑用 `window.prompt`（1320-1331）；附件只有下载链接、无预览。
- 3c 确认：列表行只有「点标题开详情」一种交互（1250-1257），无操作列；无改状态/删除的快捷入口；后端**没有 DELETE 工单端点**（feedback.ts:341 methodNotAllowed）。
- 4 确认：登录页是两个裸 input（admin.html:319-333），登出 = `location.reload()`（1119-1121），无登出端点；整个后台无框架、无组件库、无构建步骤（`deploy-mikiko-cloud.yml` 无 build 步骤，public/ 原样上传）。

## D.2 脚手架选型（问题 4）

**采用：`packages/mikiko-cloud/admin/` 新建 Vite + React + TS + Tailwind + shadcn/ui 管理台 SPA，构建产物输出至 `public/admin/`。**

依据（来自现状核查）：

- 仓库已有同模式先例：`packages/web`（`@zcode/web`）即 Vite + React，构建静态产物挂 Cloudflare——monorepo 内无障碍（pnpm workspace 已含 `packages/*`）。
- Worker 静态资源约束：`wrangler.toml [assets] directory = "./public"` 只支持单目录 → **Vite `outDir` 直接指向 `../public/admin`**（`emptyOutDir` 开启），public 根的官网/share 页不动。
- 部署：`.github/workflows/deploy-mikiko-cloud.yml` 增加 `pnpm --filter mikiko-cloud-admin build` 步骤（在 wrangler deploy 之前）；本地 `wrangler dev` 前需先 build（package.json dev script 串行化）。
- 路由注意（来自历史报障）：`run_worker_first` 含 `/`，所有页面请求先过 Worker 再透传 assets；SPA 放 `/admin/`（`public/admin/index.html`），Worker 兜底 `env.ASSETS.fetch` 透传即可，不新增 Worker 路由分支；旧 `/admin.html` 重定向到 `/admin/`（301，保留一个过渡周期后删除旧文件）。
- UI 基线：后台为内部工具，不强制对齐桌面端 `DESIGN.md`；采用 shadcn/ui 默认主题 + 暗色支持，降低维护面。

## D.3 后台信息架构（问题 3a + 产品需求模块）

左侧固定菜单 + 右侧内容区（替代纵向堆叠）：

```text
┌──────────┬──────────────────────────────────────────┐
│ Mikiko   │  [当前页标题 + 管理员菜单(登出)]              │
│ 云管理后台 │                                          │
│          │  模型预设配置 | 功能配置 | 问题反馈工单 | 产品需求 │
│ ▸ 模型预设 │  ……                                      │
│ ▸ 功能配置 │                                          │
│ ▸ 问题反馈 │                                          │
│ ▸ 产品需求 │                                          │
└──────────┴──────────────────────────────────────────┘
```

- **模型预设配置**：迁移既有表单编辑器（modelRules/modelApiRules/providerSiteRules 三分区 + JSON 模式 + 发布历史/恢复）。首版可先整体搬移现有 renderForm 逻辑为 React 组件，表单能力不回退（templateRules 等仍 JSON 模式，维持现状）。
- **功能配置**：动态工作流灰度 + 分享限流（两个控件）。
- **问题反馈工单**：见 D.5/D.6。
- **产品需求**：与工单同构的列表 + 详情抽屉（kind=feature 过滤视图），见 Part C.2.b。
- 登录页：独立居中卡片（产品 logo + 账密 + 错误提示 + loading），session 探测自动进入；登出按钮 → 新增 `POST /api/v1/admin/logout`（清 cookie）。

## D.4 后端补齐（mikiko-cloud Worker + D1）

migration `0002-feedback-account.sql`（与 Part F 共用）：

```sql
ALTER TABLE feedback_tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'bug';      -- 'bug' | 'feature'（Part C）
ALTER TABLE feedback_tickets ADD COLUMN owner_sub TEXT;                        -- KeyCloak sub（Part F，可空=匿名/历史）
ALTER TABLE feedback_tickets ADD COLUMN owner_email TEXT;
CREATE INDEX idx_feedback_tickets_owner ON feedback_tickets(owner_sub, updated_at DESC);
CREATE INDEX idx_feedback_tickets_kind ON feedback_tickets(kind, updated_at DESC);
```

API 变更：

| 端点 | 变更 |
| --- | --- |
| `DELETE /api/v1/admin/feedback/tickets/{id}` | **新增**：D1 删除（CASCADE 带走评论/附件记录）+ R2 清理（`list` prefix `feedback/{ticketId}/` 逐个 `delete`，失败仅记日志不阻塞） |
| `GET .../tickets` | 过滤参数增加 `kind`、`owner`（Part F/D 列表页） |
| `POST /api/v1/feedback/tickets`（客户端） | 接受可选 `kind`（默认 bug）与可选 Bearer KeyCloak token（Part F） |
| `GET .../tickets/{id}/attachments/{aid}?disposition=inline` | 图片预览用 inline 变体（仅 image/* 允许 inline；默认仍 attachment） |
| `POST /api/v1/admin/logout` | 新增，清 session cookie |

## D.5 工单列表页改造（问题 3c）

- **列顺序**：工单标题（首列，左对齐、超宽截断 + tooltip）→ 状态（彩色 badge）→ 类型 → kind（Bug/需求，仅总视图显示）→ 联系方式 → 附件数 → 更新时间 → 创建时间 → **操作列**。
- **操作列**：① 状态快捷修改（下拉直选，复用 PATCH）；② 删除（confirm 对话框 → DELETE，成功后列表刷新）；③ 「详情」打开抽屉。
- 行为细节：删除需二次确认（输入工单 id 或标题前缀防误删，内部工具从简：confirm 弹窗 + 红色按钮即可）；状态修改即时生效无需进详情。

## D.6 工单详情抽屉（问题 3b）

右侧滑入 Drawer（宽 ~min(960px, 90vw)），**左右两栏**：

```text
┌──────────── 工单 #fb-xxx ───────────────────────────────┐
│ ┌─────────────── 左栏 ───────────────┐ ┌──── 右栏 ────┐ │
│ │ 状态/类型/kind/fix_version/assignee  │ │ 评论时间轴    │ │
│ │ （行内编辑表单，保存=PATCH）          │ │ (author/body │ │
│ │ 标题 / 描述 / 环境 JSON / 联系方式    │ │  /时间，编辑  │ │
│ │ 截图 grid：缩略图，点击灯箱放大       │ │  删除沿用既有 │ │
│ │ 日志归档 zip：下载按钮 + 大小         │ │  PATCH/DELETE)│ │
│ │ 附件下载（截图单独下载）              │ │ ──────────   │ │
│ │ 设备/账号信息（owner_email、device）  │ │ 新评论表单    │ │
│ └───────────────────────────────────┘ │ author+body   │ │
│                                        └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- 截图预览：缩略图走 inline 变体端点（D.4），点击全屏 lightbox（放大/ESC 关闭）；下载按钮走原 attachment 端点。
- 评论时间轴：竖向 timeline，编辑/删除替换 `window.prompt`/`confirm` 为表单内联编辑与 confirm 对话框。
- 打开抽屉时列表保持不动（URL 可带 `?ticket=id` 便于刷新回位）。

## D.7 测试与部署

- Worker 侧 `node --test`：DELETE 工单（含 R2 清理、404）、kind/owner 过滤、inline disposition 白名单、logout。
- admin SPA：Vitest 组件冒烟（列表渲染/抽屉开关/操作回调），后台内部工具从简，不强制 E2E。
- 部署顺序：migration 0002（与 Part F 一次性）→ CI 增 build 步骤 → 打 tag 发布；旧 admin.html 保留一个版本周期做回退。

---

# Part E. Mikiko ID 主账号化：远控设备注册与 OIDC 直连（问题 5）

## E.1 复核结论：**确认现状，且为全新能力（无既有账号体系）**

- mikiko-remote = 自研 relay（`packages/relay-server`，部署 `wss://ws.mikiko.ai`）+ 手机页（`remote.mikiko.ai`，Cloudflare Pages，产物来自 `packages/web` Vite 构建）。
- 当前手机连接**唯一入口是桌面签发的 HMAC 票据**（二维码/授权链接）：桌面开启远控 → relay `issueSession` 签发 `sid + accessHash`（`relay-server/src/state.ts:159-211`，短时 10min / 长效无 TTL）→ 组装 `https://remote.mikiko.ai?sid&hash&t&mid&ws`（`server.ts:515-540`）→ 手机 `POST /api/rc/bind` 换 sessionToken → `/ws/phone` 建连。**relay 与网页均无任何用户账号概念**（spec §2 明确列为非目标；全仓 `oidc/keycloak` 零命中）。
- 已有可复用资产：`POST /api/rc/devices` 设备注册端点（无鉴权，`server.ts:175-225`）；在线状态天然存在（`desktopRoutes.has(mid)`）；手机连接器 `RemoteControlApp.tsx` 的 bind/connect/P2P 全套；桌面 `registerDevice`（`wiring.ts:124-137`）上送 `{mid,name,appVersion}`；web 端登录体系有 provider 抽象（zai/bigmodel，可加第三 provider）。
- 桌面侧缺口：当前没有 Mikiko ID 登录态——**由 Part A 补齐**（`StoredAccount.oidc.refreshToken` + `getOIDCAccessToken`）。

## E.2 目标链路（新增「账号直连」，二维码票据双轨保留）

```text
【设备认领】桌面 App（MikikoCC OIDC 已登录 + 远控开启）
   registerDevice {mid,name,appVersion} + Authorization: Bearer <KeyCloak access_token>
   ──▶ relay 验签(JWKS) → devices[mid].ownerSub = sub（内存态，桌面重连自动 re-claim）

【网页登录】remote.mikiko.ai
   Mikiko ID 登录（client mikiko_remote，Public+PKCE，回调 /oidc/callback）
   → GET /api/rc/account/devices（Bearer access_token）
   → 返回 [{mid,name,online(=desktopRoutes.has(mid)),lastSeenAt,appVersion}]
   → 用户点「连接」→ POST /api/rc/account/connect {mid}
   → relay 校验：token 归属 == devices[mid].ownerSub 且桌面在线
   → 复用 issueSession 直接签发 sid+sessionToken（跳过 HMAC 票据）
   → 返回 {sid, sessionToken, relayWsBase} → 前端复用既有 connect() 建连（免票据/免扫码）
```

## E.3 relay-server 改造（packages/relay-server）

1. **OIDC 验签层**：env 新增 `RELAY_OIDC_ISSUER`（`https://oauth.mikiko.ai/realms/mikiko`）。启动/懒加载 discovery + JWKS（缓存 + kid 轮换刷新），WebCrypto RS256 验签 access_token，校验 `iss`/`azp ∈ {mikiko_remote, mikiko_code}`/`exp`，提取 `sub`。**零依赖约束的取舍**：优先手写 WebCrypto 验签（约百行，保持 spec §15.6 的单文件零依赖纪律）；若实现复杂度失控再引 `jose` 并同步修订 spec（§13 决策点 6）。
2. **设备归属**：`RelayState.devices` 记录增加 `ownerSub?`。`POST /api/rc/devices` 接受可选 `Authorization: Bearer` 头：带 token 且验签通过 → 注册同时 claim（`ownerSub` 为空或等于本次 sub 时写入；已被其他 sub 占用时拒绝改绑，返回冲突错误）。新增 `POST /api/rc/devices/claim`（桌面登录态变化后单独补认领，body 空、Bearer 鉴权）。**内存态保持**（spec §6.7 零盘语义不破）：relay 重启后绑定丢失，桌面断线重连时携带 token 自动 re-claim——桌面持有 offline refresh token，可行。
3. **账号端点**（Bearer 鉴权）：
   - `GET /api/rc/account/devices`：返回 owner 下设备列表 + 在线状态（`desktopRoutes.has(mid)`）+ `lastSeenAt`。
   - `POST /api/rc/account/connect {mid}`：归属与在线校验 → `issueSession`（复用现有状态机：sid 生成、单活票据踢旧 pending/ready、不打断 bound 会话）→ 直接铸 sessionToken 返回。桌面无需预先同意：`stream_open` 自动 attach 流程（`desktop/src/main/remoteControl/service.ts:296-343`）原样复用。
4. **CORS**：`/api/rc/*` 现为 `Access-Control-Allow-Origin: *`（`server.ts:132-136`），需补 `Access-Control-Allow-Headers: Authorization`；`/api/rc/account/*` 收敛为 `https://remote.mikiko.ai` 白名单（带凭据头后不宜再 `*`）。
5. **协议兼容**：全部为新增 HTTP 端点，不动 WS 帧/桌面控制帧 → **不 bump `REMOTE_CONTROL_PROTOCOL_VERSION`**；`/healthz` capabilities 增加能力位（`accountApi: 1`），旧客户端无感。
6. **spec 修订**：`specs/remote/mobile-remote-control.md` 新增「§23 账号直连（OIDC）」章节，写明信任模型（同票据持有人级信任：本人账号即本人设备）、双轨并存、内存绑定语义。

## E.4 桌面端改造（packages/desktop + services）

- `remoteControl/wiring.ts` `registerDevice` 调用处：若 MikikoCC OIDC 已登录（`getOIDCIdentity("mikikocc")` 命中），取 `getOIDCAccessToken`（offline refresh 换短时 access token）附 Bearer 注册；远控服务增加对 sub2api `onDidChange` 的订阅——登录/换号/登出时：登录 → re-claim（`/devices/claim`）；登出 → 本地清绑定提示（relay 侧绑定由下次登录覆盖或自然过期）。
- 顺序约束：远控 `start()` 与 OIDC 登录无固定先后（两个独立入口）——registerDevice 无 token 时照旧匿名注册；登录完成后异步补 claim，不阻塞远控启动。
- 配置：`remote-control.json` 不新增字段（issuer 走 relay 侧 env，桌面无需感知 KeyCloak）。

## E.5 remote.mikiko.ai 前端（packages/web）

- **登录**：`packages/web/src/auth/` 新增第三个 provider `mikiko-id`（结构照抄 `zaiWebOAuthProvider`：OIDC 授权码 + PKCE、CSRF state 复用 `oauthStateCodec`、凭据存储按 provider 分段 `browserOAuthCredentialRepo`）；回调路由 `/oidc/callback` 加入 `isWebOAuthCallback`（`main.tsx:279-287`）。token 仅存内存/sessionStorage（页面刷新重走静默授权）。
- **设备列表页**：新路由（`/devices` 或登录后首页）：设备卡片列表（名称/在线点/最近在线/版本）+ 「发起远控」按钮。连接逻辑复用 `RemoteControlApp.tsx`：`bind()` 替换为 `/api/rc/account/connect` 结果（sid/sessionToken/wsBase），`connect()`/重连/终态码/P2P 零改动。
- 手机页保留票据入口（`?sid&hash&ws` 分支不动），双轨。

## E.6 验收

- relay 单测：验签（有效/过期/错 issuer/错 azp）、claim 冲突、account/devices 在线投影、account/connect 踢旧票据语义与 bound 会话不被打断、CORS 头。
- E2E（线上 KeyCloak + 线上 relay 预发）：桌面登录 MikikoCC → 开远控 → 网页登录同账号 → 设备在线 → 直连成功可操作；换账号不可见对方设备；未登录直连 401。
- 回归：二维码票据链路全流程不变。

---

# Part F. 反馈/需求记录账户化与本地记录迁移（问题 6）

## F.1 复核结论：**确认，且客户端已预留迁移接口**

- 客户端现状（`specs/mikiko-cloud/feedback-tickets.md` §1）：本地优先，创建成功写 `~/.mikiko/feedback/tickets.json`（`syncState: synced`），云端失败写 `pending-sync` 后抛错；「我的反馈」一律读本地（换设备不同步）；本地记录不支持评论。**`FeedbackAccountSync` 空实现已预留**（`packages/services/src/feedback/feedbackService.ts:57-65` noop，314 工厂桩），注释明确「接入统一 OAuth 后：上报记录补 userId；实现 syncPendingLocalRecords 按 clientTicketId 对账迁移」——本 Part 即落地该预留。
- 服务端现状：工单只挂 `device_hash`（migration 0001，注释已声明为 OAuth 迁移预留）；无用户表（不新建独立用户表，直接以 KeyCloak `sub` 为账号键，见 F.2）。

## F.2 方案：以 KeyCloak sub 为账号键（不建用户表）

身份即 `owner_sub`（KeyCloak sub）+ `owner_email`，随单冗余存储（D1 migration 0002 已加列）。**不新建用户/账号表**：反馈域的「账号」没有独立属性（无偏好/无配额），建表反而引入第二个身份事实源；KeyCloak 是唯一身份源，sub 直接为键（对齐 AGENTS.md「避免重复状态与多条写入路径」）。

### F.2.1 服务端（mikiko-cloud）

- **验签**：Worker 侧校验 Bearer KeyCloak access token（JWKS + RS256，WebCrypto 手写或 `jose`——Workers 环境两者皆可，与 E.3 决策点共用结论）；仅信任 `azp ∈ {mikiko_code}`（桌面 App 上报路径；`mikiko_remote` 的 token 不用于反馈）。
- `POST /api/v1/feedback/tickets`：可选 Bearer——验签通过则落 `owner_sub/owner_email`（email 取平台账号或 token claims）；无效 token **拒绝整单**（fail-close，不带匿名降级：用户已登录态上报却验签失败属于配置异常，静默降匿名会造成记录丢归属）。
- `GET /api/v1/feedback/tickets/mine`（新增，Bearer）：当前账号的工单列表（含 kind，分页 + 状态过滤），替代「我的反馈」读本地。
- `POST /api/v1/feedback/tickets/{id}/comments`（新增客户端能力，Bearer + 归属校验）：打开本地记录模式下「评论不支持」的限制；`GET /api/v1/feedback/tickets/{id}`（Bearer + 归属）供详情刷新。
- 对账端点 `POST /api/v1/feedback/tickets/migrate`（Bearer）：body `[{clientTicketId, title, description, contact, environment, appVersion, platform, locale, createdAt}]`；服务端按 `client_ticket_id + owner_sub` 幂等处理：已存在 → 保留（不覆盖跟进状态）；不存在 → 按 `kind=bug` 创建并回填原 `created_at`。返回 `{migrated, skipped}`。

### F.2.2 客户端（ZCode services/ui）

- **上报带用户信息**：`FeedbackSubmitForm` 与 `FeatureRequestDialog` 提交时，若 MikikoCC OIDC 已登录（`getOIDCIdentity("mikikocc")`），自动附 Bearer（`getOIDCAccessToken` 换短时 token，失败则整单报错重试，不静默匿名）；未登录维持现状（设备 token 匿名上报）。
- **查询走远端**：「我的反馈」（`TicketsView`/`TicketDetail`）登录态下改调 `/feedback/tickets/mine` 与详情/评论端点；未登录回落本地档案（现状）。本地 `tickets.json` 退化为「未登录时代的兜底 + 迁移源」。
- **自动同步（登录后）**：实现 `FeedbackAccountSync.syncPendingLocalRecords()`：
  1. 订阅 sub2api `onOIDCLoginCompleted`（首次登录/换号触发一次；换号时先做上账号的迁移再切换视图）；
  2. 读本地全部记录（`synced` + `pending-sync`），调 `/tickets/migrate` 对账；
  3. 成功后：本地档案**整体清除**（按用户要求：`tickets.json` 清空为空结构；失败保留原档，下次登录重试）；
  4. UI 提示一次性 toast「历史反馈已同步到 Mikiko 账号」。
- **登录后的新记录**：直接带 Bearer 上报远端成功后，本地仍写一份 `synced` 记录（离线可看）？——**不写**：查询已走远端，本地不再积累新档案，仅保留迁移前的旧档语义；避免双写双源。
- 评论能力：登录态工单详情打开「追加评论」（走新评论端点）；本地（未登录）记录维持不支持（现状）。

## F.3 验收

- Worker 测试：Bearer 验签矩阵、mine/migrate 幂等（重复迁移零重复）、fail-close、评论归属校验。
- services 测试：FeedbackAccountSync 对账（mock fetch：部分成功/全部成功/网络失败重试）、登录触发时机、本地档案清除边界（失败不清）。
- E2E：未登录匿名上报 → 登录 → 自动迁移 → 「我的反馈」远端可见且本地清档；登录态直接上报即挂账号；换设备登录同账号可见历史。

---

# Part G. 凭证生命周期：MikikoCC 平台 token 与 Mikiko ID 凭证的持续续期（追加项 2）

## G.1 复核结论：**需求成立，且发现一个存量缺陷**

需要维持两类凭据（均已核实现状）：

1. **MikikoCC 平台 token（token-exchange 换来的 pair）**——余额/订阅（60-120s 轮询 `getAccountDetail`）与模型列表（`refreshKeyModels`/`verifyKey`）都靠它。现状：**反应式刷新**——请求 401 时 `panelRequestWithRefresh` → `refreshSiteToken`（`sub2apiService.ts:367-396`）。
   **存量缺陷（已定位）**：`refreshSiteToken` 成功后只变异内存 `site.account`，**没有任何 `saveConfig`/`persistSilently` 落盘**（`sub2apiService.ts:387-394` 之后直接 return）；只有后续 `getAccountDetail` 恰好检出余额变化时才连带落盘。sub2api 的 `/api/v1/auth/refresh` 会**轮换 refresh token**（旧 token 立即失效，文档 §4.2 与源码一致）——轮换后若未落盘即退出应用，磁盘上仍是已作废旧 token，重启后刷新必失败，用户被静默登出。
2. **Mikiko ID（KeyCloak）凭证**——Part E/F 的身份依赖。现状（本方案 A.3）：持久化 offline `refreshToken` + `sub`；access/id token 不落盘。KeyCloak offline token 默认不过期、默认不轮换（realm 可配轮换），但会因用户在 Mikiko ID 控制台撤销会话/管理员操作而失效。

## G.2 方案

### G.2.1 平台 token：主动续期 + 轮换必落盘（可独立于 Part A 先行）

- **落盘修复（缺陷修）**：`refreshSiteToken` 成功后立即 `persistSilently`（沿用「高频路径静默持久化」纪律；refresh 属账号字段变更但非结构变更，静默即可，不触发 onDidChange 闪环）。该修复对**存量账密账号同样生效**（含 sub2api 站点——`refreshSiteToken` 是共用路径；属缺陷修复而非行为变更，不违反「不改 sub2api」边界）。
- **主动续期**：登录态站点维护 `expiresAt`；余额轮询入口 `getAccountDetail`（唯一周期调用方）执行前检查 `accessToken` 剩余有效期 < 120s（或已过期）→ 先走一次刷新再拉取，替代「先 401 再重放」的反应式路径（反应式 401 分支保留为兜底）。刷新+落盘仍发生在 `configWriteMethods` 写队列内（`getAccountDetail` 已在队列，无新增并发面）。
- **刷新失败分级**：网络类失败保留旧 token 下轮重试（现状语义）；明确拒绝（refresh token 失效/账号禁用）→ 清账号态 + `onDidChange` 广播 + UI 登录态收敛（MikikoCC 引导重登 OIDC；sub2api 站点引导重新账密登录）。
- **模型列表联动**：`refreshKeyModels` 前同样走「有效期检查 → 必要时刷新」，避免长周期未打开设置页导致模型清单拉取 401 失败后不再重试。

### G.2.2 KeyCloak OIDC 凭证：按需刷新 + 启动校验 + 轮换自适应

- **按需（lazy）为主**：`getOIDCAccessToken(siteId)`（A.6.2 接口）在每次被调用时（Part E 设备认领/续期、Part F 反馈上报）执行：内存缓存 access token（`exp - 60s` 内直接复用）→ 过期则用 offline `refreshToken` 走 `grant_type=refresh_token`（`sub2apiOidcClient.refreshOidcAccessToken`）→ **若响应携带新 refresh_token（realm 开了轮换）立即覆盖持久化**（`persistSilently`），未携带则沿用。
- **启动校验（轻量）**：应用启动存在 mikikocc OIDC 账号时，不主动刷新（避免无谓出网）；仅在首个需要身份的调用点触发。若 refresh 返回 `invalid_grant`（会话被撤销）：清 `StoredAccount.oidc`（保留平台 token 会话不受影响）+ warn 日志 + 经 `onDidChange` 让远控/反馈模块感知身份降级（Part E 的设备绑定自然失效，属预期）。
- **不做常驻定时器**：KeyCloak 凭据只在被消费时需要有效，「维持有效性」由按需刷新 + 失败降级保证；常驻续期心跳只会白白消耗 offline session 的空闲额度（realm idle 策略对 offline session 默认不适用，但无意义出网仍应避免）。
- **并发防护**：`getOIDCAccessToken` 在途时合并并发调用（单飞 promise），避免多个消费方同时刷新触发 KeyCloak 重放检测（若 realm 开启 reuse detection，并发用同一 refresh token 第二次会被拒）。

### G.2.3 验收

- 单测：refresh 成功必落盘（磁盘为新 token）；轮换返回新 refresh_token 时覆盖；余额轮询前主动刷新触发条件（<120s）与跳过条件；刷新明确拒绝 → 清态广播，网络失败 → 保留旧值；`getOIDCAccessToken` 单飞合并、`invalid_grant` 清 oidc 不清平台 token。
- E2E：登录后等待 access 过期 → footer 余额仍能持续刷新；杀进程重启后（轮换过的 token 已落盘）不被登出；控制台撤销会话后，反馈/远控身份降级但平台会话可用。

---

# Part H. 三步引导勾选导入后迁移窗口未弹出（追加项 3）

## H.1 复核结论：**属实，根因定位（意图竞态）**

复现路径差异（均已对照源码）：

- **首启路径（坏）**：首次引导是**替换式全屏渲染**（`OccupationOnboarding.tsx:219`：不可见才渲染 children），引导期间 `OnboardingDialog`（迁移弹窗宿主，挂在主界面里）**未挂载**。`save()` 完成时（`OccupationOnboarding.tsx:240-241`）先 `setRequested(false)`（主界面开始挂载）再 `requestOnboardingDialog("migration")`（store 置标志）。`OnboardingDialog` 挂载后两个 effect 竞态：
  1. 挂载 effect（`OnboardingDialog.tsx:178-193`）读到标志 → `setView("wizard")` + `settingsSync.actions.reopen()` → 弹窗打开；
  2. 但 `useSettingsSync` 自身的挂载 effect（`useSettingsSync.ts:236-287`）同时启动异步首启检测：`getFirstRunPromptState()` 未处理 → `loadDiscovery("firstRun")` → 检测结果为空（三方 agent 迁移已移除后首启检测**恒为空**，`useSettingsSync.ts:193-200` 注释自证）→ `markFirstRunPromptHandled()` + **`setState(createInitialState())` 把 `open` 重置为 false**——刚刚被 `reopen()` 打开的弹窗被这条迟到的异步链关闭，用户看到「没弹出迁移窗口」。`reopen()` 自己补跑的 `loadDiscovery("manual")`（空结果保持 open=true）与这条 firstRun 链并发，后完成者胜，结果不确定但大概率被 firstRun 关闭。
  2. **设置页重走路径（好）**：此时 `getFirstRunPromptState().handled` 已为 true（首启时已被 `markFirstRunPromptHandled`）→ 挂载 effect 直接重置初始态返回，**没有 firstRun 检测链参与竞态**，`reopen()` 的 manual 检测空结果保持 open=true → 弹窗正常。
- 佐证：`reopen()`（`useSettingsSync.ts:314-324`）的注释只考虑了「设置页重新打开」场景，未考虑「与首启 firstRun 检测并发」。

## H.2 修复方案：manual 意图抢占 firstRun 检测

在 `useSettingsSync` 内引入**意图抢占**（最小侵入，不改 OnboardingDialog）：

1. `manualRequestIdRef` 计数器：`reopen()` 时自增并捕获当前值。
2. `loadDiscovery(intent)` 闭包捕获进入时的 manual 计数；**任何 `setState` 提交前检查计数是否已变**——已变则放弃本次结果（包括 firstRun 的「空结果自动关闭」与 open:true 设置），由 manual 路径全权接管。
3. firstRun 空结果的 `markFirstRunPromptHandled()` 同样受抢占保护：若 manual 已介入则跳过标记（用户正在迁移向导中，不应把首启提示消费掉；向导正常关闭时 `close()` 自会落库）。
4. 兜底顺序约束：`OnboardingDialog` 的挂载 effect 在 `settingsSync` 初始化完成前不消费标志也可接受（现状即可），抢占领的只是检测链的迟到覆盖。

## H.3 验收

- 单测（hook 层，按仓库测试形态 mock settingsSyncService）：构造「挂载即 firstRun 检测在途 + 立即 reopen("manual")」序列 → 弹窗保持 open 且不执行 `markFirstRunPromptHandled`；仅 firstRun（无 manual）→ 空结果照旧关闭并标记；manual 空结果保持 open。
- E2E：全新环境首启 → 三步引导勾选导入 → 点「开始使用」→ 迁移向导弹出且停留在会话导入步骤；设置页重走路径回归不变。
- spec 更新：`specs/desktop/onboarding-migration.md` UI 节补记该竞态与抢占规则。

---

# Part I. 首登（欢迎页）后新建会话页模型列表为空（追加项 4）

## I.1 复核结论：**现象可信，但静态链路已覆盖——定位为「登录后自动同步静默失败 + 无重试」，需日志证实**

静态复核结果（好消息是主链路是通的）：

1. 登录时自动同步已实现：`login`/`loginWith2FA` 内 await `syncProviders`（`sub2apiService.ts:894-902`，注释「登录后自动同步供应商与模型列表（用户需求 #3）：不再依赖用户打开设置页才触发」）——客户描述的「没进模型列表页所以没触发同步」在当前版本已不成立。
2. 事件链完整：`syncProviders` 经 `providerSettingsService`（facade）写入 → `#mutate` 尾部 `registryService.refresh("settings:…")`（`facades.ts:470-478`）→ registry `onDidChange` → `createModelSelectionService` emit（`providerFacadeServices.ts:239-256`）→ composer 的 `useModelSelectionServiceView` 订阅重读（`useModelSelectionView.ts:154-163`）。且新会话页在登录完成后才挂载，首读即应命中已同步数据。

**残余缺口（推断为真实根因，两项均指向首启时序）**：

- **静默失败无重试**：登录内 `syncProviders` 的 try/catch **吞掉全部失败**（「同步失败不阻断登录返回；用户进设置页可手动重试」）。首启时 provider 配置运行时（builtin 配置远拉、personalRepository 初始化）可能尚未 ready，或首次网关模型清单拉取超时——同步失败即静默，登录成功但零供应商；用户进设置页触发的刷新链（`Sub2ApiSection` 挂载即拉站点/密钥/模型）实际充当了「手动重试」，与「进过模型设置页才恢复」的现象吻合。
- **消费侧无空态自愈**：composer 侧 `useModelSelectionServiceView` 首读失败仅两次有界重读（`useModelSelectionView.ts:27-28`），之后不再自发起读；若首读落在同步完成前的窗口且期间无 registry 事件（同步失败时确实没有），空列表会一直停留。

## I.2 修复方案：失败可见 + 空态自愈

1. **登录同步失败不静默**：`Sub2ApiLoginResult`/`onOIDCLoginCompleted` 事件增加 `syncError?: string`；UI 登录成功 toast 提示「模型列表同步失败，可在设置中重试」（不阻断进入主界面）。
2. **一次自动重试**：`login`（与 OIDC 完成续体）内 `syncProviders` 失败后，延迟 5s 在写队列内重试一次（首启 ready 竞态的窗口即被覆盖）；仍失败走 1 的显式提示。
3. **消费侧空态自愈（防御）**：`useDraftConfigControl` 侧对「已登录站点存在但模型候选为空」的状态提供可见刷新入口（复用 hook 的 `reload()`），避免任何未知时序问题再把用户困在空列表。
4. **不引入常驻轮询**：模型清单事实归 provider registry 所有，UI 侧只补「一次重试 + 手动刷新」，不开第二条定期同步路径（遵守单一所有者约束）。

## I.3 验证与验收

- **先证实再合修**：按「定位问题时先调查」纪律，拿到一份客户复现日志（`[sub2api]` 前缀 + `[model-selection]`/registry 相关 warn）确认失败点落在 syncProviders（超时/未 ready/模型清单拉取），排除其它未知路径后再合并修复。
- 单测：login 内 sync 失败 → 5s 重试一次 → 仍失败返回 `syncError`；成功则不带。
- E2E：全新数据目录（慢网模拟 builtin 拉取）→ 欢迎页登录 → 直接进新建会话页 → 模型列表非空；同步失败场景出现提示且设置页手动重试可用。
- spec 更新：`specs/desktop/sub2api-gateway.md`「同步语义」节补「登录同步失败的重试与显式提示」条目。

# 12. 实施顺序（建议四批；批次 1 较 rev1 扩容）

| 批次 | 内容 | 备注 |
| --- | --- | --- |
| 1（立即可做，无外部依赖） | B 工作树展示修复；C-a 隐藏「提交漏洞」；H 引导迁移窗口竞态修复；I 模型列表空态修复（先取客户日志证实）；G.2.1 平台 token 落盘修复（存量缺陷，独立小改）；D 脚手架搭建 + 登录页/Tab 骨架 + 工单列表列序/操作列/详情抽屉（含后端 DELETE/inline/logout） | B/C-a/H/G.2.1 均为独立小改可先行合入；I 建议与日志证实同批 |
| 2（sub2api + KeyCloak 运维就绪后） | A MikikoCC OIDC 登录全量 + **MikikoCC 账密逻辑彻底移除**（UI 全入口 + 服务端守卫；含 allowlist 前置任务）；G.2.1 主动续期部分（expiresAt 检查）；D 的产品需求 Tab（migration 0002 一起上） | KeyCloak：mikiko_code 切 Public、redirect、offline_access 确认；上线即无账密回退，回滚 = revert 版本 |
| 3（A 完成后） | G.2.2 KeyCloak 凭证按需续期（getOIDCAccessToken 单飞 + invalid_grant 降级）；F 反馈账户化 + 自动迁移 | migration 0002 若未随批次 2 上则随本批 |
| 4（A + 运维建 client 后） | E 远控 OIDC 直连（relay + 桌面 + remote.mikiko.ai） | KeyCloak 建 `mikiko_remote`；relay 先升（新端点灰度） |

# 12.5 批次 2 实施记录（2026-10-20，rev4）

- **ZCode 侧全量落地**：通用 loopback 监听器（chatgpt 等价重构回归通过）、`sub2apiOidcClient`、`sub2apiService` OIDC 编排（登录/取消/事件/身份接口/单飞刷新/主动续期/A.9 迁移/账密守卫）、refresh token 经 credentialService 加密存储、UI 全入口 `method` 分流（欢迎页 + 设置页）。测试：31/31 node:test（含真实 loopback 回环的编排用例与 KeyCloak/面板契约 mock），typecheck/lint/architecture 全绿。
- **KeyCloak 线上已切换（运维完成）**：`mikiko_code` → Public + PKCE S256 强制（原已配）+ redirect 增加 `http://127.0.0.1:*`；direct grant 保持关闭；切换前配置备份于运维机（client uuid e1b89960）。`offline_access` 确认可用。
- **端到端验证（线上 KeyCloak + 本地 mock 面板）已通过**：授权码 + PKCE → 真实登录（专用测试账号 `zcode-oidc-e2e@mikiko.ai`，凭据记于运维 .env）→ 随机端口 loopback 回调 → 真实 token 端点（id_token 的 sub/azp=email_verified/nonce 全部校验通过，offline refresh token 获取）→ token-exchange（mock）。**sub2api allowlist（A.4 前置 #3）上线后需用真实 mikiko.cc 复验 token-exchange 一段。**
- **待办**：sub2api `token_exchange_allowed_clients` 实现并登记 `mikiko_code`（外部仓库）；桌面 E2E 用例（批次 1 遗留 + OIDC 登录场景，需应用构建窗口）。

# 12.6 批次 3 实施记录（2026-10-20，rev5）

- **真实链路复验通过（A.4 前置 #3 已闭环）**：sub2api `token_exchange_allowed_clients` 上线后，用线上 KeyCloak + 真实账号完成授权 → id_token → **真实 mikiko.cc token-exchange** → 平台 token → `/auth/me` 拉到真实账号数据。Part A 生产链路全绿。
- **F 后端（mikiko-cloud，commit 3513e1c3）**：migration 0002（kind/owner）、oidcTokenVerify（手写 WebCrypto JWKS RS256）、账号端点（mine/详情/评论/migrate 含匿名行认领）、admin DELETE/kind+owner 过滤/inline 预览/logout。测试 43/43。
- **F 客户端（services，commit af40af03）**：账号通道（登录态创建挂 owner+kind）、远端「我的反馈」、本人评论、`syncAccountRecords`（登录事件自动触发迁移+清档）。测试 5/5 新增。
- **mikiko-cloud 已先行发布（用户授权）并完成生产冒烟**：D1 migration 0002 远端应用 ✅、worker 部署（版本 b78f8521，含 MIKIKO_OIDC_ISSUER var）✅。生产验证：无凭据 mine 401 / 真实 KeyCloak Bearer mine 200（生产 WebCrypto JWKS 验签链路对真 KeyCloak 生效）/ Bearer 建单 kind=feature 挂 owner / mine 可见 ownerEmail / admin DELETE 清理后归零——生产读写闭环完成。
- **桌面 E2E 用例已编写（未本地执行通过）**：`mikikocc-oidc-login.test.ts`（真实 KeyCloak 全链路 + I 模型列表断言）、`onboarding-migration-dialog.test.ts`（H 竞态回归）。两用例 typecheck 通过；本地 wdio 执行受阻于环境问题——`.e2e-cache` 中发现并清除陈旧 chromedriver-147（与 Electron 41/Chromium 146 不匹配，DevToolsActivePort 失败，属仓库级修复），此后会话创建仍在沙箱内握手超时（应用本体手动启动正常）。需在交互式 macOS 会话或 CI runner 上执行后计入通过口径。

# 13. 待决策点汇总（rev3：全部裁定）

1. **登出联动 KeyCloak realm**：❌ 不联动（已裁定）。
2. **MikikoCC 账密入口**：已裁定彻底移除（无折叠入口）。**追加（rev3）**：新版本安装后做一次性升级迁移——检测到本地历史已登录的 MikikoCC 账号及其模型列表信息时，清除该账号态并按 logout 同语义级联清理其供应商/密钥/模型配置，引导用户以 OIDC 重新登录并重新初始化模型列表（迁移设计见 A.9）。
3. **私有 scheme 深链回调**：暂不做；仅在 loopback 被拦截且非做不可时再启动（已裁定）。
4. **sub2api 自建站点**：明确不接 OIDC，保持账密登录（已裁定）。
5. **产品需求状态机**：按建议——首版复用工单状态枚举（已裁定）。
6. **OIDC 验签选型**：按建议——两端手写 WebCrypto（relay 保持零依赖），复杂度失控再统一引 `jose`（已裁定）。
7. **KeyCloak Refresh Token 存储**：**必须加密独立存储，不允许明文**（已裁定）。修订 A.3：`StoredAccount.oidc` 只保留 `sub/email/credentialKey`，refresh token 经 `credentialService`（加密凭据库）以独立键（如 `sub2api:mikikocc:oidc-refresh-token`）存取，`sub2api.json` 不出现明文 token；登出/换号时删除对应凭据键。
8. **智谱遗留清理**：能清理就清理，不影响现有功能。「提交漏洞」菜单**彻底清除**（菜单项 + hook + i18n + `clientConfig.zsrcUrl` 解析链路，若无其他消费方）；**追加（rev3）**：「产品文档」「用户社群」两个菜单**隐藏**（实现保留，后续改为自实现链接再恢复）。
9. **G.2.1 主动续期的提前量**：`expiresAt` 前 120s 刷新为初值，联调中按 `expires_in` 实际值调整。

# 14. 明确不做的事

- 不改 `kind === "sub2api"` 站点的登录、Turnstile、2FA、登出任何行为；
- 不引入内嵌 WebView 登录形态；不做深链回调、KeyCloak end_session 联动（裁定见 §13）；
- **KeyCloak refresh token 不落明文**（§13.7：credentialService 加密独立存储）；
- 不动智谱 OAuth、ChatGPT OAuth 任何行为（chatgptOAuthClient 仅做监听器等价重构）；
- E 不做「桌面确认弹窗」式直连审批（信任模型 = 本人账号即本人设备，与票据持有人同级）；不做 relay 持久化存储（内存绑定 + 桌面 re-claim）；
- F 不新建用户表（KeyCloak sub 直接为账号键）；登录后新反馈不再写本地档案（查询走远端）。
