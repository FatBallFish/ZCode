# 设置页信息架构与用量统计整理（2026-10-12）

## 背景与需求

1. 系统设置的独立「Mikiko 网关」菜单与「模型设置」里的中转站站点管理重复，移除独立菜单。
2. 使用统计的「中转站用量」与「中转站套餐」两页合并：套餐（余额 + 订阅窗口用量）放用量页顶部；
   并支持多个 sub2api 站点账号间的切换（原先只取第一个已登录站点）。
3. Tab 顺序：应用用量 → 智谱套餐（个人/团队相邻）→ 中转站用量 → ChatGPT 用量。
4. 新增「ChatGPT 用量」Tab：统计经 ChatGPT 账号 provider 产生的模型用量 + 账户自身信息
   （订阅、credits 余额、5h/7d 窗口、重置次数）。

## 决策

### D1 移除「Mikiko 网关」设置分区

- `settingsPageConfig` / SettingsPage 侧栏项删除；`SettingsSectionId` 的 `"sub2api"`
  保留并加入 `HIDDEN_SETTINGS_SECTIONS`（历史 last-section 偏好与旧 intent 回落默认分区，
  对齐 automations/plugins 先例）。
- `Sub2ApiSection` 组件保留——模型设置的站点详情仍复用其内容；站点级 intent
  （`sub2apiSiteId` → 模型设置站点节点）不受影响。
- 未登录文案指向「设置 → 模型设置」。

### D2 中转站用量页合并与多站点

- `UsageStatsSectionTab` 删除 `"sub2api-plan"`（历史 intent 值回落 `"sub2api"`）。
- `Sub2ApiUsagePanel` 单视图：顶部「账户余额 + 订阅套餐卡片（原 plan 视图内容）」，
  其下为原 usage 视图（热力图/时间线/模型汇总）。
- 多站点：`sites.filter(site => site.account)` 全量列出，站点超过一个时顶部显示站点切换
  （SegmentPill，与智谱多套餐 Tab 同族交互；用户口径「Switch 组件」按站点数自适应，
  单站点不渲染切换器）；切换后 usage/accountDetail 按所选 siteId 重新拉取。

### D3 ChatGPT 用量 Tab

- 数据源 A（用量统计）：agent 库 `model_usage.provider_id` 已随每次请求写入；
  `AppUsageQueryInput` 增加可选 `providerId`，`queryAppUsage` 全部聚合 SQL 增加等值过滤，
  协议 `usage/stats` 入参与 services `getAppUsageSnapshot` 透传；UI 按当前账户
  `account:chatgpt:{accountId}` 精确过滤。快照结构（AppUsageSnapshot）不变。
- 数据源 B（账户信息）：`chatgptAccountService.getAccounts()`（既有脱敏视图：
  email/plan/usage 窗口/credits/resetCredits）。
- `ChatGPTUsagePanel`：账户切换（多账户 SegmentPill）+ 账户信息卡（订阅类型/credits/
  窗口剩余/重置次数）+ 用量区（复用 AppUsagePanel 的图表组件，providerId 过滤）。
- 无账户时空态引导到「设置 → 模型设置 → ChatGPT」。

## 验收场景

1. 设置侧栏无「Mikiko 网关」项；模型设置内站点管理完整可用；旧 last-section 偏好含
   sub2api 时打开默认分区。
2. 使用统计：仅一个「中转站用量」Tab；顶部余额+套餐卡片；图表在下；多站点可切换。
3. Tab 顺序：智谱个人/团队相邻，中转站在其后，ChatGPT 最后。
4. ChatGPT 用量：多账户切换、账户卡正确、用量数字仅统计该账户 provider 的请求；
   无账户显示引导空态。
