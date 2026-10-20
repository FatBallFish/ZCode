# 上游 v3.16.2 合入独立评审

评审日期：2026-10-20。评审者为 UI 集成协作者；本报告只审查其他协作者负责的高风险边界，不把自己的实现自评当作独立证据。

- 完整二开基线：`af8285c2`；上游来源：`075fde84`。
- 检查对象：当前 index + worktree；检查时 HEAD 为 `25c136ac531a59b4e70aa19dd4056ee27de9e286`，尚未提交最终集成。
- 依据：`specs/integration/upstream-v3.16.2.md`、当前源码、与二开基线及上游来源的差异、实际包测试入口。
- 方法：采用 requesting-code-review 技能的需求与基线对照方法；只读审查和无网络纯函数复现，不改业务源码、不启动大测试、不操作正式账号或发布服务。

## 评审结论

未发现 Critical。初次审查发现两个 Important，均集中在官方 CodingPlan 与自建产品端点的隔离；现已逐项复核关闭，当前评审范围内无未解决的 Critical/Important。以下保留发现时的触发与证据，并记录修复闭环，避免把问题历史写成仍待处理。测试入口遗漏已由负责协作者修正，完整门禁仍以最终实际执行结果为准，不能把静态入口修复记成测试通过。

### Important 1：生产环境自定义自建域仍会改写官方账号端点

定位：`packages/shared/src/zcodeEndpoint.ts` 的 `resolveCodingPlanEndpointOrigin`（发现时第 473–475 行），以及 `buildZCodeEndpointUrls` 的 CodingPlan 地址投影；调用方包括 `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` 的 `createOAuthClient`。

真实触发：生产部署把 `MIKIKO_BASE_URL` 配为默认域之外的自建 origin，例如 `https://cloud.custom.example`，随后执行 CodingPlan OAuth 登录或查询账单。

证据：独立执行当前纯函数得到：

```text
MIKIKO_ENV=production, MIKIKO_BASE_URL=https://agent.mikiko.ai
productOrigin=https://agent.mikiko.ai
codingPlanOrigin=https://zcode.z.ai

MIKIKO_ENV=production, MIKIKO_BASE_URL=https://cloud.custom.example
productOrigin=https://cloud.custom.example
codingPlanOrigin=https://cloud.custom.example
billingUrl=https://cloud.custom.example/api/v1/zcode-plan/billing/current
```

现实现只识别精确默认自建域。普通产品部署地址因此会改变官方账号登录目标，偏离“只有官方 CodingPlan 账号业务保留官方合同”的要求；CLI 的 `/oauth/cli/init` 也会落到没有该官方账号实现的自建服务。

建议修复：由 shared 唯一 resolver 区分生产账号 origin 与产品 origin。生产账号保持官方；保留已有非生产显式测试 origin 合同。`buildRuntimeZCodeEndpointUrls(env)` 与 `resolveRuntimeProductEndpointConfig(env)` 必须把账号 resolver 的结果传给纯 builder，避免 StartPlan balance 绕过修复。不要修改远控、分享回调等产品字段的 origin。

建议验证：覆盖 production 的默认域/自定义域、test 的显式 HTTP fixture；在同一环境同时断言产品 API 仍自建、CLI OAuth init 与四个 CodingPlan 地址仍官方。额外覆盖 provider OAuth token URL、StartPlan balance 和额度重置，防止只修一个调用点。

状态：**已关闭**。只读复核确认 shared resolver 对 production 始终返回官方账号 origin，非生产显式测试源继续保留。两个 runtime builder 显式传入账号 origin；纯 builder 的账号字段默认官方，既有 loopback fixture 兼容仍在。远控、分享和普通产品 API 的 origin 不随之改变。

闭环证据：审查者再次独立调用纯函数，验证 production 的默认自建域、不同自建域、loopback 三种产品地址，其四个 runtime 账号地址与 runtime config 均保持官方，产品 origin 保持配置值；test 的显式账号测试源及纯 builder loopback 合同继续生效，退出码 0。已读取 `/tmp/mikiko-account-boundary-red.log` 中 production 自定义域断言先失败、`/tmp/mikiko-account-boundary-green.log` 中六个 suite / 264 项全部通过的真实结果。大测试由父协作者执行，审查者未重复启动。

### Important 2：手动领取套餐及官方 MCP 额度仍使用普通产品 API builder

定位：`packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` 的 `getManualClaimPlanPreviews` 和 `claimManualPlan`（发现时第 268、335 行）；`packages/services/src/usage-stats/providers/zcodeMcpQuotaProvider.ts` 的 `fetchMcpQuotaSnapshot`（发现时第 210 行）；对照 `packages/mikiko-cloud/src/worker.ts` 的只读代理（发现时第 140–158 行）。

真实触发：使用默认 Mikiko 生产端点、已登录官方账号，在套餐页预览/领取手动套餐，或查询官方 MCP 套餐额度。

证据：三个请求调用 `buildRuntimeZCodeApiUrl`，分别访问自建域的：

```text
GET  /api/v1/zcode-plan/billing/preview
POST /api/v1/zcode-plan/billing/claim
GET  /api/v1/mcp/usage
```

自建 Worker 只对 GET billing 路径提供公开只读代理，并明确不转发 Authorization；POST claim 不在该代理合同内。结果是预览的官方鉴权丢失，领取请求无法到达官方实现。修复账号 origin resolver 本身不会改变这两个普通 builder 调用。

官方 MCP quota 的 URL 同样由普通 builder 生成，随后附加 `buildOfficialMcpAuthHeaders` 产生的 JWT Authorization、CodingPlan `X-Bigmodel-Authorization` 及 Team 组织/项目 scope 头。该方法先校验明确的官方套餐 scope，属于官方账号额度业务；自建 Worker 无该额度接口，不能继续向产品域发送这组账号材料。该第三处由父协作者发现、独立审查源码确认。

建议修复：三个账号操作使用现有 `buildRuntimeCodingPlanApiUrl`，与 OAuth/额度重置使用相同官方账号 owner。不要为了这些调用把产品通用 API builder 改为官方。

建议验证：实际 provider 请求捕获同时断言预览 GET、领取 POST、MCP usage GET 的官方 origin、JWT/CodingPlan/verification headers、Team scope 和请求正文；配置自建产品域后结果仍相同；非生产 HTTP fixture 按既有测试合同运行。不要仅验证 shared helper。

状态：**已关闭**。只读复核确认 `getManualClaimPlanPreviews`、`claimManualPlan`、`fetchMcpQuotaSnapshot` 均改用现有账号专用 builder；既有鉴权、scope、verification 和 body 构造没有改变。套餐 client-config 仍走自建专用 `/api/v1/coding-plan/client/configs` 代理，普通产品 builder 没被改写。

闭环证据：已审查 `codingPlanSubscriptionService.test.ts` 新增 production `private-product.example` 场景，通过实际 provider 请求捕获同时断言预览与领取的官方 URL、路径和 JWT。`zcodeMcpQuota.test.ts` 使用该生产产品域查询 ZAI Team，断言实际 MCP usage URL 为官方、JWT 与 CodingPlan 双鉴权保持、套餐归属保持。已读取 `/tmp/mikiko-account-boundary-red.log` 中两条套餐请求先错误指向产品域，以及 `/tmp/mikiko-mcp-account-boundary-red.log` 中 MCP usage 同样先红的结果；修复后上述六个 suite / 264 项全部通过。未访问真实账号或生产服务。

## 已检查且未发现新增阻塞的边界

| 边界                     | 代码和实际证据                                                                                                                                                                                                                                             | 覆盖限制                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| CLI 新旧 env 优先级      | `parseEnvConfig` 先读 ZCODE 再读 MIKIKO；两种枚举顺序实际调用均选择新 storage 路径。显式自定义 prefix 不混用默认 namespace。`isMessageEnabled` 的 MIKIKO=0 实际覆盖旧 true。                                                                               | 未启动完整 CLI 或真实代理请求；完整包测试由负责协作者执行。                                          |
| Core Memory 敏感路径     | 相对上游，敏感集合为严格超集：保留 `.claude`、`.zcode`，新增 `.mikiko`；permission/path-policy 与 memory override 没有其他品牌替换删除。实际纯函数验证三种名称、大小写、尾点、零宽字符、ADS 变体继续受保护，兄弟目录 `.mikiko-notes` 不误阻。              | 未新增运行时权限测试；已检查 override 保留显式 deny、project ask、hook ask 和 alwaysAsk 的代码顺序。 |
| Source Server 自建发布   | `prepareSourceServerPublication` 在发布前校验四 target、version、SHA/size、manifest 和原始 build identity；发布先上传并读回不可变对象，后提交 descriptor/catalog；下载与更新默认源均为 Mikiko。                                                            | 未调用真实 R2、GitHub、签名或发布凭据；不把源码检查当作线上发布成功。                                |
| 旧 sourceRunId 恢复      | `.github/scripts/release-artifacts.mjs` 读取原 run 的 SHA/tag 和原提交 workflow。原 workflow 无 source-server job 时明确 legacy 跳过；有 job 但缺 artifact、commit/tag/version 不符时失败，不重建当前 HEAD。对应 workflow 测试包含这几种真实脚本 fixture。 | 未在 GitHub Actions 真正恢复历史 run；本次独立评审未重复执行这些测试。                               |
| CodingPlan client config | provider 使用 `/api/v1/coding-plan/client/configs`，自建 Worker 专门映射官方只读配置；没有错误占用普通 `/api/v1/client/configs`。Desktop 远控 manager 和 Web OAuth callback 的纯 builder 调用只消费产品字段，不能跟随账号修复改 origin。                   | 账号预览/领取仍受 Important 2 约束。                                                                 |

## 测试入口完整性检查

静态 inventory 发现并反馈了两组遗漏：

1. CLI 显式 Node 命令未包含 `tests/sea-official-plugin-assets.test.mjs`；`tests/mode-menu.test.ts` 使用 Vitest，需要单独入口，不能塞给 Node runner。负责协作者已将默认 `test` 串联 `test:node` 与 `test:vitest`。
2. adapters/bootstrap/core 共十个源码旁 Vitest 文件未被只包含 `test/`、`tests/` 的根配置及包命令选中，包含 MCP App authorization、session persistence concurrency、MCP UI contract/races。它们在完整二开基线已存在，不作为本次新增运行时缺陷；但本次完整测试门禁应纳入。负责协作者已接受修正根 include 与包过滤范围。

另已检查 Browser 三个外部 CDP Node 文件由默认命令串联其 Node 入口；Adapters 两个 ChatGPT Node 文件由默认链执行，避免交给 Vitest；TUI 的 Node glob 与 Office 的本地 Vitest include 分别覆盖自身目录。

这些入口修正的测试数量和真实结果以最终验收报告为准。本独立评审未执行全量测试、真实 OAuth、生产云操作、跨平台安装或远控 E2E。

## 2026-10-21：主工作区 Source Server 模块登记复核

审查者：Desktop/Web 集成协作者。审查目录为 `/Users/fatballfish/Documents/Projects/ClientProjects/ZCode`，基线为 `220e237424d9e5926494dda8f49abb3a5d0b7248`；旧集成 worktree 不在本轮修改范围。Host 五件套由本审查者实现，因此本轮仅核对其 policy 登记，不将其实现自评作为独立验证；另外五个模块按源码、公开导出、实际 import 和基线 diff 独立复核。

**结论：本轮范围内未发现 Critical/Important。** 未修改业务源码、policy 或提交；未启动测试或类型构建，父任务正在运行的联合测试及根型检须以其最终真实结果记账。

| 模块                                | 实际依赖与公开边界复核                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-source-server`                | `desktop/rpc/server/services/shared` 与既有 manager/directory imports 对应；公开合同与两个原文件入口均登记。未增加 registry、连接 owner 或持久化写入路径。                                                                                                                             |
| `source-server-transport`           | `server/shared` 对应 backend、命令工具及共享类型；contract 导出原工厂、probe、错误和类型，原 adapter/probe 入口保留。类型仅抽到本模块 `types.ts`，旧 adapter 继续 type re-export；参数、可选字段、取消与返回签名不变。probe 的反向引用改为 `import type`，未新增运行时代码或连接缓存。 |
| `source-server-release-contract`    | `release.ts` 只依赖外部 zod，`requires: []` 真实；原 schema/常量/类型直接 re-export，纯 domain 登记与代码相符，没有 IO 或第二份校验器。                                                                                                                                                |
| `source-server-workspace-migration` | `services/session/shared/sqlite-migrations` 覆盖路径工具、任务迁移、共享身份和 session migration。原 AliasRepo 与 off-peak 函数保留入口，合同复用原迁移 owner，未增加事务、备份或 ledger 副本。                                                                                        |
| `source-server-packaging`           | `shared/zcode-server-cli` 与 descriptor、归档、平台工具依赖相符；只导出原 release/archive 函数。拥有顶层 `await main()` 的 `stageRemoteAssetsCli.ts` 仅登记归属，不列入公开入口，也未被 contract/example/test 导入。                                                                   |
| `source-server-daemon-boundary`     | `services/zcode-server-cli` 覆盖 logger、原 ReleaseManager、控制通道与状态读取；contract 只导出既有 handoff/proxy。创建/导入新边界不启动 daemon、不打开 stdio 连接；显式调用继续复用原进程边界与 release 指针 owner。                                                                  |

精确继承例外只包含 `max-file-lines` 与 `disable-count` 两类规则的三条文件路径。通过 `git hash-object` 与 `git ls-tree 220e2374` 独立核对，当前实际内容、基线内容与理由所列 blob 全部相同：

| 文件                                                              | 基线与当前 blob                            | 继承诊断                       |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| `packages/desktop/src/host/sourceServerConnectionManager.ts`      | `316082a2d779fe6cedcbd2794df4ace3c44a9670` | 1460 行，1条 max-lines disable |
| `packages/desktop/src/host/sourceServerDirectory.ts`              | `96824fd484897db1aa251e08a4d4d1521523c0a6` | 1486 行，1条 max-lines disable |
| `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts` | `ca33914f6067d993f2566b2efebc05440716a2b2` | 2354 行，1条 max-lines disable |

这些例外不豁免依赖、循环、层级或新增文件登记；没有新增全局路径通配例外、改阈值或刷新 baseline 掩盖违规。transport 的 suppression 删除伴随完整类型抽取，其实现现为455行，未拆出隐藏运行时 owner。

AliasRepo 新测试的隔离条件已静态追踪到真实实现：空输入用唯一临时目录显式提供 task/session/backup 三个路径，原方法在任何建目录或开库前 trim 并拒绝；测试断言目录为空并在 finally 清理。另一测试仅构造公开冲突错误，不创建 Repo 或数据库。没有修改 HOME/环境，也未使用默认用户数据库路径。其断言只覆盖空输入及公开错误合同，不冒称覆盖真实双库迁移与恢复。
