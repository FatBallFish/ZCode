# R6：MCP 运行绑定与 Image Search 验收

## 运行入口修复

共享插件缓存只持有资产与声明。`resolveZCodePlugins` 在 discovery 后调用 `bindOfficialPluginMcpRuntime`，由每次消费的当前进程独占运行命令绑定；不再把缓存最后写入者的 Node flags 或入口当权威。

只处理 marketplace、完整 plugin id、enabled 和 namespaced mcpServerNames 全部匹配的官方 stdio。遇到旧 `__zcode-plugin-host` 包装，只保留其后的 server path/参数；原始参数直接保留。当前进程 prefix 仍由原 `createBundledMcpRuntimeConfig` 产生；cwd/env/auth/timeout/isolation/protocol 保留，ELECTRON_RUN_AS_NODE=1。输入 outcome、metadata 与旧缓存都不修改。第三方、HTTP/SSE、用户显式服务器及禁用项保持原合同；下述用户明确追加的 Image Search HTTP 后端例外单独处理。

先红后绿：旧归档测试入口/flags、raw args、跨当前入口重绑定、输入不变与非目标条目保护均由测试证明。真实 PDF、presentations、spreadsheets 服务使用当前已构建 CLI 的 plugin-host 通道启动，完成 initialize、tools/list UI metadata、panel resource 与实际 UI script resource 读取。未改个人插件缓存或数据库。

## Image Search 后端与登录门禁

用户追加授权默认使用官方 CodingPlan 搜图后端，且仅当前智谱 BigModel/Z.ai 登录时有效。源 `.mcp.json` 和 Mikiko manifest 都声明官方 fallback；每次消费的最终 URL 仍由独立 account resolver 决定，生产自建产品 origin 不能改写它。manifest 采用 `.mikiko-plugin`，产品名称与说明为 Mikiko。

官方 Image Search 的全部请求逐次取得有效账号身份，账号不可用、未登录、缺 auth port 或空身份头时在发出请求前以稳定 `OfficialMcpAuthError.kind` 拒绝，错误明确说明需登录/重新连接账号。门禁不依赖日志用的 JSON body/method 解析。其他 MCP 的既有匿名初始化合同不变；shared 专用官方 MCP origin 信任工厂由主任务提供，双端限制账号凭据目的地。

后续自建实现接入 `ResolveZCodePluginsOptions.imageSearchBackend`：默认 `kind: "official-coding-plan"`；显式 `kind: "custom"` 的 `createMcpConfig(existing)` 返回自建 HTTP MCP 配置。工厂强制移除官方 auth/provenance，不能继承官方 token 注入路径。此端口没有实现任何未选定供应商，也没有新增云部署。

## 实际验证

- **58/58** 用例通过，覆盖 4 个定向文件，maxWorkers=1，全部经 `scripts/run-isolated-tests.mjs`。
- Image Search 使用真实 HTTP SDK 与 loopback 服务完成 initialize、tools/list、tools/call 和模拟 panel resource 读取；每条请求携带合成账号头。未登录分支 **0 请求**。未执行真实官方图片搜索或消耗额度。
- bootstrap/adapters `tsc --noEmit` 均退出 0；定向格式检查通过。
- 根 lint 默认忽略 apps/zcode-cli。临时配置只移除了该 ignore，保持原规则，7 个目标文件结果 **0 errors / 3 既有 warnings**：plugins.ts 存量行数、sep unused、workingDirectory unused。未为本修复增加 suppression。
- 两个运行源文件合并覆盖率：statements 89.09%、branches 79.22%、functions 96.87%、lines 93.38%。这是定向文件覆盖，不代表全仓覆盖。
- 当前 Vitest/coverage-v8 补丁版本不一致有工具告警；执行退出 0 并生成完整 JSON。没有修改依赖或放宽断言。

从仓库根目录可复跑：

```sh
mise exec -- node scripts/run-isolated-tests.mjs node node_modules/vitest/vitest.mjs run \
  --root "$PWD/apps/zcode-cli" --config "$PWD/apps/zcode-cli/vitest.config.ts" \
  packages/bootstrap/tests/official-plugin-runtime.test.ts \
  packages/bootstrap/tests/official-plugin-runtime-stdio.test.ts \
  packages/adapters/tests/mcp-official-auth.test.ts \
  packages/adapters/tests/image-search-backend-loopback.test.ts \
  --maxWorkers 1
```

JSON 结果随本文保存。原始日志与覆盖率：`/tmp/mikiko-image-search-red.json`、`/tmp/mikiko-per-runtime-mcp-red.json`、`/tmp/mikiko-image-search-green.log`、`/tmp/mikiko-image-search-coverage/coverage-final.json`。

源码已交主任务统一构建最新 CLI/Dev bundle，并由其完成真实桌面面板与状态验收。本报告的 Office stdio 验证使用本地已构建 CLI/插件资产；它不代替主任务最新构建后的桌面 UI 验收。
