# 官方CodingPlan模型404修复验收

## 根因与修复

1.1.4官方个人CodingPlan调用GLM-5.3-Flash时，bootstrap将产品origin注入静态网关，官方SDK地址因此转到agent.mikiko.ai的ultra路径。自建服务不提供该接口，线上Node POST探测返回404。该来源与既有官方账号例外规格不一致。

修复复用共享 `resolveCodingPlanEndpointOrigin`，由bootstrap统一装配和按账号origin/网络策略复用port。生产产品域不会决定模型鉴权目标；显式测试环境保留隔离注入。原adapter精确匹配与公共fetch透传不变，不修改用户配置/登录态。

方案与事件图见[规格](../../apps/zcode-cli/docs/design/v2/model/provider-endpoint-routing.md)，执行步骤见[修复方案](../plans/2026-10-21-coding-plan-gateway-fix.md)。

## 实际执行结果

| 检查                       | 结果                                                  | 证据                                                                                                      |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 红态回归                   | 6项因错误生产路由/复用身份失败；4项通过，确认命中根因 | `/tmp/mikiko-coding-gateway-red.log`                                                                      |
| CLI路由/公共fetch/模型执行 | 4文件57项通过，含真实本地HTTP                         | `/tmp/mikiko-coding-gateway-green.log`                                                                    |
| shared端点边界             | 25项通过，覆盖产品/账号来源分离                       | `/tmp/mikiko-coding-gateway-shared.log`                                                                   |
| 根类型检查                 | 通过                                                  | `/tmp/mikiko-coding-gateway-typecheck.log`                                                                |
| 根lint                     | 0错误、174项既有warning                               | `/tmp/mikiko-coding-gateway-lint.log`                                                                     |
| CLI类型检查                | 32/32任务成功，28项缓存                               | `/tmp/mikiko-coding-gateway-cli-typecheck.log`                                                            |
| CLI lint                   | 0错误、74项warning，接纳9项原样上游行数诊断           | `/tmp/mikiko-coding-gateway-cli-lint.log`                                                                 |
| 架构                       | 改动前后0 violation                                   | `/tmp/mikiko-coding-gateway-architecture-before.log`、`/tmp/mikiko-coding-gateway-architecture-after.log` |

CLI根目录的vitest/turbo命令入口未链接到本地bin：定向测试使用根vitest加CLI配置；CLI typecheck在PATH前置现有根node_modules/.bin后执行原脚本，不安装/变更依赖。

## 真实官方账号推理

北京时间2026-10-21 16:35，使用现有本机智谱OAuth登录态及生产换证resolver，进入修复后的bootstrap路由和公共fetch。只发送合成提示 `Reply with OK.`，模型GLM-5.3-Flash、最多32输出token、流式响应。

- 最终目标：`https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`。
- HTTP200，收到文本delta以及message_stop，真实推理通过。
- 只读本地凭据；鉴权网络仅允许bigmodel.cn的GET及短期access_tokens换证，禁止创建/修改API key；未发送项目内容、未输出或落盘凭据。
- 证据：`.cache/mikiko-coding-plan-fix/live-proof.json`、`/tmp/mikiko-coding-gateway-live.log`，只含非敏感结果。

海外账号覆盖静态路径和transport回归，未使用真实海外账号推理。本次未重启用户正式App，未打包/推送/发布；已安装1.1.4不会因源码提交自动改变。
