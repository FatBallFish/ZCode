# 对外请求 User-Agent 品牌

## 目标

产品品牌已由 ZCode 更名为 Mikiko。所有真实对外请求的 `User-Agent` 值必须以 `Mikiko` 开头；这是品牌展示约束，不改变任何请求语义。

## 构造点（唯一所有者按层划分）

| 出口                                                                | 文件                                                                    | User-Agent                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| 桌面/服务层模型 API、遥测等（`buildZCodeSourceHeadersFromContext`） | `packages/shared/src/zcode-source-headers.ts`                           | `Mikiko/<appVersion>`，无版本时 `Mikiko/unknown`            |
| CLI runtime 模型请求（`buildCliZCodeSourceHeaders`）                | `apps/zcode-cli/packages/bootstrap/src/model-config.ts`                 | `Mikiko/<appVersion>`                                       |
| WebFetch 工具抓取外站                                               | `apps/zcode-cli/packages/core/src/tool/handlers/webfetch-constants.ts`  | `Mikiko-WebFetch/0.1 (+https://zcode.ai; coding-agent-cli)` |
| 插件安装器下载 GitHub 归档                                          | `apps/zcode-cli/packages/adapters/src/plugins/github-archive-source.ts` | `Mikiko-Plugin-Installer`                                   |

新增对外出口必须复用上表对应层的构造点，不得再手写第三份 UA 字符串。

## 明确不改的项

- `X-Title`（`Z Code@<source>`）与 `X-ZCode-App-Version`、`X-ZCode-Agent` 等自定义头：属于后端服务契约，品牌更名不自动改写；如需调整必须与后端对齐后单独变更。
- `Mikiko-WebFetch` 中括号内的联系 URL 仍指向 `https://zcode.ai`；待 Mikiko 官网域名确定后与 UA 一并更新。

## 验收场景

1. 桌面正式包经代理抓包：模型 API 请求 `User-Agent` 以 `Mikiko/<版本>` 开头，无 `ZCode/` 前缀。
2. CLI 直连运行模型请求：同上。
3. 会话内使用 WebFetch 工具：目标站点收到的 `User-Agent` 为 `Mikiko-WebFetch/…`。
4. 安装公开 GitHub 插件：GitHub 收到的 `User-Agent` 为 `Mikiko-Plugin-Installer`。
