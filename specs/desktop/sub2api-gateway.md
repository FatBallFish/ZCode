# Sub2API 中转站网关

状态所有者、写串行化与多站点生命周期规则。实现：`packages/services/src/sub2api/sub2apiService.ts`，UI：`packages/ui/src/settings/Sub2ApiSection.tsx`。

## 配置唯一所有者与写串行化

- `sub2api.json`（`<dataRoot>/v2/sub2api.json`）是站点、密钥、providerBindings、keyModels、modelConfigs 的唯一持久化事实，服务实例独占写。
- **所有改写配置的方法（addSite / bindSiteAddress / removeSite / login / loginWith2FA / logout / getAccountDetail / refreshAccount / listKeys / createKey / updateKey / deleteKey / activateKey / refreshKeyModels / syncProviders / setSiteEnabled / setModelConfig）整体排队串行执行**：方法体是「loadConfig 捕获快照 → await 网络（超时最长 25s）→ 写回」的形状，不串行化时任何在途流程都会用旧快照覆盖磁盘（丢更新）。
- 串行化通过 `serializedService` 代理在返回值上实现；闭包内部自调用（login → syncProviders、refreshAccount → getAccountDetail）持 raw 引用直接进原方法，在调用方队列槽内执行，禁止重入排队（死锁）。
- 新增写方法时必须加入 `configWriteMethods`；纯读方法不加锁。
- 背景写者常驻存在：UI 余额定时刷新（60-120s 随机）会调用 getAccountDetail + listKeys。任何「后台刷新 vs 用户操作」并发正确性由上述串行化保证，不得靠超时或重试兜底。
- `persistSilently` 只省略 onDidChange 广播，不豁免串行化。

### 验收场景（回归测试 `packages/services/test/sub2apiConfigWriteRace.test.ts`）

1. listKeys 在途（网络挂起）时并发 addSite("about:blank")：占位站点必须在 listKeys 写回后仍存在，bindSiteAddress 必须成功。
2. listKeys 在途时并发 removeSite：站点删除后不得被 listKeys 的旧快照写回复活。

## 站点生命周期

- 内置 MikikoCC 站点不可删除、无需绑定地址。
- 「添加供应商 → sub2api」创建 `pendingBind: true` 占位记录（panelBaseUrl 为空，跳过远端校验）；用户在设置页填地址后经 `bindSiteAddress` 探测 `/api/v1/settings/public` 完成绑定。
- `removeSite` 级联删除该站点全部密钥对应的个人供应商，并按「{brand} · 」前缀兜底清扫历史幽灵供应商；删除失败要明确报错，不静默吞。
- 站点删除后 `findSite` 抛「站点不存在」；UI 对删除竞态期间的级联报错静默处理，并把 `selectedSiteId` 收敛到真实站点。

## 设置页「跟随左下角当前展示账户」

- 跟随源（2026-09-24 修订）：**App 左下角 footer 当前展示的账户**，不是会话选中模型的供应商。展示规则见 `packages/ui/src/lib/sidebarAccount.ts`（`useSidebarAccountDisplay`）：菜单选中站点优先；未选中且无智谱 OAuth 用户时回退首个已登录站点；有 OAuth 用户时展示智谱账号。选中态存窗口级 store（`sidebarRelayAccountSiteId`），工作区与设置页两个 footer 实例共享——本地 state 会在实例切换时丢失，导致进设置页回落智谱账号展示。
- 入口写意图：
  - footer 齿轮（工作区侧）：`setPendingModelProviderTarget`（只预置目标、不改打开分区）——展示中转站账号 → `{relaySiteId}`；展示智谱账号 → 清空目标（模型设置页默认家族侧）。
  - Composer 的模型设置按钮（`SessionPane.handleOpenModelSettings`）：`setPendingSettingsSectionIntent("modelProvider", ...)` 携带同样的账户目标。
- 意图解析在 `packages/ui/src/settings/model-provider-section/providerTargetResolution.ts`（纯函数，可被 node:test 直接加载）：
  - `relaySiteId`（站点目标）→ 已知站点则 `relay:{siteId}` 节点（右侧渲染该站点的 Sub2ApiSection）；
  - 内置 Coding Plan（智谱/Bigmodel 个人/团队/Start）→ 家族侧节点；
  - 中转站密钥投影供应商（providerBindings 命中）→ `relay:{siteId}` 站点节点；
  - 普通自定义供应商 → `custom:{id}` 节点；
  - 供应商列表或中转站站点未加载完成 → `pending`，由 `ModelProviderSection` 在数据到达后重试，不消费意图；
  - 数据就绪后仍无法定位 → `invalid`（提示无法打开目标供应商）。
- **验收**：footer 展示中转站账号时进入设置-模型设置，必须选中对应中转站站点节点并展示该站点账号信息；footer 展示智谱账号时落智谱家族侧。不得因「非内置 ID」被判无效而回退到智谱 Coding Plan 侧（历史 bug：设置页自动切到智谱账户），也不得按会话选中模型定位（用户明确否决）。

## Footer 账户展示与切换菜单（2026-09-25）

- **订阅 badge 只跟随智谱账号**：`WorkspaceSidebarFooterPlanBadge`（用量摘要里的订阅标签）仅在 footer 当前展示智谱 OAuth 账号（`user` 存在且 `relaySite == null`）时渲染。切到中转站账号后名称/余额已切换，badge 必须同步消失——它属于智谱账号的订阅信息，不属于中转站。
- **账号切换菜单**：菜单里的中转站站点列表区块（`sub2ApiAuthedSites.length > 0` 时展示）首项增加智谱账号条目（仅当 `user` 存在）——否则从中转站切走后无处切回。点击智谱条目 = `setRelaySiteSelection(null)`；选中态圆点判定 `!relaySite`，与中转站条目（`siteId === relaySite?.siteId`）互斥。仅有智谱账号、无中转站站点时该区块整体不展示（无需切换）。
- **验收**：智谱账号带订阅 → 切到中转站后 badge 消失、名称变邮箱、副标题变余额；切回智谱后 badge 恢复。中转站登录态下打开菜单可见智谱条目并可切回；退出登录的中转站站点自动落到下一个登录账号（既有行为不变）。

## 同步语义

- `syncProviders` 按站点互斥（`syncInFlight`），login 内置自动同步，UI 不重复触发。
- 差量更新：已有供应商的 api.type 以当前生效值为准（用户手动改过不回退）；同步清单外的用户手动模型保留；孤儿供应商按名称前缀认领或清理。
- 模型 API 类型推断：anthropic → anthropic-messages；openai 且全量 gpt- 前缀 → openai-responses；其余 openai-chat-completions。虚拟模型（SUB2API_VIRTUAL_MODEL_IDS）不进清单。

## 模型推荐配置（智能配置落盘）

- 推荐规则目录（`zcode-builtin`）的 provider-site 规则全部绑定官方端点 baseUrl，中转站网关常规 resolve 匹配不到任何 properties（输入类型/能力/推理等级为空的根因）。
- 同步投影时按「模型 ID + API 格式」**忽略 baseUrl** 匹配推荐规则（`ModelConfigRules.resolveForRelayModel`）：model-api 规则全部叠加，provider-site 规则取 modelMatch 最具体的一条，结果作为推荐配置快照随模型条目落盘（`useRecommendedConfig=true`，未设置字段仍跟随推荐更新）。
- 用户在 `modelConfigs` 里手动覆盖过的模型不落快照，完全以用户配置为准。
- 历史已同步、个人配置为空（未落推荐且用户未改过）的模型在下一次同步时通过 `savePersonalModelDraft` 补写快照；revision 冲突时本轮跳过、下次重试。
- 推荐解析按「apiType::modelId」会话级缓存（null 表示已解析且无推荐），多密钥同模型与重复同步不重复解析。
- **验收**（`packages/services/test/sub2apiModelRecommendation.test.ts`）：relay baseUrl 常规 resolve 为空而 `resolveForRelayModel` 命中；新模型 addPersonalModel 携带推荐快照；历史空配置模型补写；同实例二次同步零重复解析。
