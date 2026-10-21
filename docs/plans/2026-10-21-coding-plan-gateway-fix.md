# CodingPlan 模型网关来源修复方案与执行计划

目标：修复1.1.4官方账号请求错误进入自建产品域而404的问题，保留官方CodingPlan账号例外和自建产品服务边界。

设计：复用 shared 的 `resolveCodingPlanEndpointOrigin`，由CLI bootstrap在创建静态路由port前解析来源；缓存key使用同一解析结果和网络策略。adapter继续只负责精确路径映射，公共fetch负责传输。无配置迁移，无新环境变量，无UI改动。

方案取舍：采用已有账号resolver使登录、订阅和推理遵循同一来源边界；在adapter硬编码官方域会失去测试注入；新增自建反向代理则引入额外鉴权和凭据转发职责。本修复无需新增服务。

规格：[Provider Endpoint Routing](../../apps/zcode-cli/docs/design/v2/model/provider-endpoint-routing.md)。

1. 在 `apps/zcode-cli/packages/bootstrap/tests/provider-endpoint-routing.test.ts` 增加生产域隔离、国内/海外路径及实际HTTP传输回归，先运行确认错误域名断言失败。
2. 修改 `apps/zcode-cli/packages/bootstrap/src/provider-endpoint-routing.ts` 的来源resolver，保留网络策略和原有DI，不修改用户数据。同步旧测试的缓存身份预期。
3. 执行bootstrap路由与adapter路由/fetch/模型执行的定向测试，执行根和CLI类型/lint及架构门禁。
4. 记录实际证据及限制，完成本地功能commit。沿用本轮只修源码要求，不打包、不推送、不发布。

测试命令从根执行：

```sh
mise exec -- pnpm exec vitest run --root apps/zcode-cli --config "$PWD/apps/zcode-cli/vitest.config.ts" packages/bootstrap/tests/provider-endpoint-routing.test.ts packages/adapters/tests/official-coding-plan-gateway.test.ts packages/adapters/tests/provider-endpoint-routing-fetch.test.ts packages/adapters/tests/model-execution.test.ts
mise exec -- pnpm typecheck
mise exec -- pnpm lint
PATH="$PWD/node_modules/.bin:$PATH" mise exec -- pnpm --dir apps/zcode-cli typecheck
mise exec -- pnpm --dir apps/zcode-cli lint
mise exec -- pnpm architecture:check --changed
```

真实官方账号推理若无法通过现有受控凭据入口完成，必须如实记录，不以mock或无鉴权401作为成功证明。
