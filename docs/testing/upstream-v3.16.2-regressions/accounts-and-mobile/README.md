# CodingPlan 与自建手机远控回归

## 已确认原因与修复

1. 官方账号 origin 从自建产品 origin 隔离后，NodeApiClient 仅对产品域补来源头。真实只读 A/B：同一实际版本 `app_version=1.1.3` 的官方 balance，仅 Authorization 为 HTTP 400/code 3001；补既有来源头为 HTTP 200/code 0。修复严格限定官方账号路径补来源头，保留调用方显式头，不改版本、不改写官方 URL。
2. 自建 CodingPlan 配置专用代理尚未部署而返回 404。Desktop/Host 改由账号 resolver 直接请求官方 `/api/v1/client/configs`，仅消费套餐/模型相关字段。兼容 `getForceUpdateConfig` 明确读已有自建 update 服务。普通功能配置、升级与其他产品云仍自建。
3. 手机真实 RPC 已连通，但入口未向 Root 传初始 workspace；禁止自行打开工作区的 Root 因而返回 null，只剩传输徽标。入口改读同一 Host 的 `lastActiveWorkspace` 窗口投影，再原子挂载 services/path/purpose/可选 task。会话列表持久化为空不影响恢复，不创建新目录/项目/Agent。
4. 手机 attachment 没有桌面专属 Sub2API 服务，惰性客户端代理却表现为存在，造成装饰性账号/badge 查询 Unknown channel。手机 UI accessor 按已有 optional 合同明确省略该服务；其他服务引用复用同一 attachment，不暴露账号完整 Key，也不逐 hook 加吞错分支。

## 验证证据

- 账号链定向 **285/285**：OAuth、quota、availability、reset、套餐配置、endpoint 与来源头；合成凭据/mock/loopback，最终用仓库隔离测试包装器执行，maxWorkers=1。
- 自建手机边界 **7/7**；workspaceBootstrap 文件语句/分支/函数/行覆盖率均 100%。
- services、web 定向 TypeScript 检查均退出 0；修改源文件定向 lint/format 检查通过。全仓 typecheck/lint/architecture 由父任务统一执行。
- 真实官方订阅只读查询 HTTP 200，确认存在有效 CodingPlan。未执行真实 reset、claim 或模型调用；保存证据不含令牌或真实账户资料。
- 手机生产页在 **393×852** 视口显示工作区与输入框；真实 `systemService.info()` 和 `settingService.get()` 成功，Root workspace 与 Host active 投影一致，Sub2API 能力缺席，P2P 徽标为“直连”，页面未处理异常 **0**。见 JSON 与截图。

测试日志与覆盖率原件：`/tmp/mikiko-account-chain-green.log`、`/tmp/mikiko-account-regression-coverage/coverage-final.json`、`/tmp/mikiko-mobile-regression-green.log`、`/tmp/mikiko-mobile-regression-coverage/coverage-final.json`。当前 Vitest 与 coverage-v8 补丁版本不一致有工具告警，但两次定向执行均退出 0 并生成完整 JSON 覆盖率；未修改依赖或放宽断言。

## 发布记录与边界

仅发布 Cloudflare Pages 项目 `mikiko-remote`，最终部署为 https://8fe0dd3f.mikiko-remote.pages.dev ，生产域 https://remote.mikiko.ai 。入口脚本 `/assets/index-DuKkTtce.js`，自建协议版本仍为 1；无 wire 协议变更。生产 `mikiko-remote-build.json` 记录源锚点 `3358e20a` 与 workingTreeChanges=true，本次包含尚未提交的修复。

发布候选构建于 `/tmp/mikiko-remote-pages-final-candidate`；移除隐藏 `.map`，避免最大 sourcemap 超过 Pages 25 MiB 限制及源码公开。最初被文件大小检查拒绝，没有发布；后续初版与最终版都记录在 `/tmp/mikiko-remote-pages-deploy.log`、`/tmp/mikiko-remote-pages-final-deploy.log`。仓库被跟踪的 dist-pages 构建副作用已恢复，仅部署临时候选。

relay `/healthz` 保持 ok，relay 自身未重新部署；未发布其他云服务，也未装配上游 Relay V2。账号代码需随桌面/Host 重新构建生效，手机静态页更新不会替换正在运行的旧 Host。

当前自建入口只有 local attachment。active 投影缺失时提示先在电脑打开工作区；active 是其他 Source 的 remote 工作区时提示切到本地工作区，禁止按相同 cwd 冒用 local Host。跨 Source 手机切换需另接既有 scoped bridge，不属于本次空白修复。

生产交互验证使用真实 Chromium 与手机视口，未使用实体手机，也未执行蜂窝弱网/断线重连压测。
