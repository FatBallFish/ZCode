# 品牌与云端边界核对

## 产品默认值

| 用途                      | 本轮结果                                                                                       | 验证方式                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 公共功能配置、分享、反馈  | `agent.mikiko.ai`，继续由 mikiko-cloud 拥有；官方账号配置走单独 CodingPlan 路由                | Cloud/分享/配置集成测试                                                             |
| 桌面更新                  | `agent-update.mikiko.ai`，下载 `agent-dl.mikiko.ai`；保留原签名/公证/恢复发布                  | update Worker、发布与恢复测试                                                       |
| 手机远控                  | `remote.mikiko.ai` / `ws.mikiko.ai`，自建票据鉴权/设备配对与既有 Host                          | 当前 relay-server 真实 WS/票据/RPC Node E2E；旧 HMAC fixture 不作为当前手机 UI 验收 |
| Source Server             | `agent-dl.mikiko.ai/mikiko/electron/releases/<version>/source-server-release.json`             | 真实 loopback descriptor→archive 下载、哈希/大小/缓存测试                           |
| Server CLI 更新目录       | `agent-dl.mikiko.ai/mikiko/server/catalog.json`，显式空覆盖允许离线                            | 默认源、发布投影、离线交接测试                                                      |
| 插件市场与图标            | `agent-dl.mikiko.ai/mikiko/official-plugin/…`                                                  | 发现/导入/内置插件协议测试                                                          |
| Office 字体               | `agent-dl.mikiko.ai/mikiko/office-skill/fonts/…`；下载时把旧列表的本地绝对路径转为相对对象 key | 脚本合同测试；远端字体集合尚未预置，不能视为线上可用                                |
| 新 Source Server 安装产物 | `.mikiko/server`、`mikiko-server-*`、`bin/mikiko`、`mikiko.cjs` 与 Mikiko 服务/env             | 安装、打包、runtime update 测试                                                     |
| Office 插件 manifest      | `.mikiko-plugin` 优先，旧格式只读兼容                                                          | CLI、server、services 各发现入口回归                                                |
| Host/CLI provider 配置    | 统一 `.mikiko/cli`；仅目标缺失时复制旧配置、不覆盖新配置                                       | 真实临时目录 paths 回归                                                             |
| 远端 prompt 附件          | 实际上传/清理根统一 `.mikiko/tmp/prompt-attachments`                                           | materialize/transfer 回归，拒绝清理根外历史路径                                     |

## 有意保留的名字

- `@zcode/*` workspace 包名、TypeScript 符号、构建期内部宏以及 repo 内部 bundle 文件名保持现有引用关系；面向分发的 CLI/安装产物另按 Mikiko 输出。
- 独立 Agent CLI 的历史 `zcode` 命令按既有 D8 合同保留；当前进程标题是 `mikiko-cli`，新 Source Server 入口是 `bin/mikiko`，不以旧命令名作为新 Server 的产品默认。
- `zcode-artifact://` 等既有协议判别器和不透明插件 ID 是持久化/协议合同；基础版本已存在，不在本次新功能中另造名称或批量改写历史数据。UI 使用对应渲染器，不把协议字符串替换当作品牌展示修复。
- `.zcode` 仅作为明确历史数据读取/惰性导入、受控自有安装迁移、兼容标识或旧测试输入保留；新增默认写入使用 Mikiko。未执行整库搬迁，也不从官方安装混入任意会话。
- 官方 CodingPlan 的 OAuth、账号、订阅、计费与供应商 API 保持官方端点；自建普通产品配置不能借该例外回流官方后端。
- CUA 签名互验涉及的原 helper 身份/第三方变量保持原合同，当前开源占位仍 fail-closed。
- Android 已有 applicationId/namespace 与旧通知 channel ID 作为安装及用户设置兼容保留；对外名称、默认远控域、UA、新 deep link/prefs 使用 Mikiko。旧链接只允许映射自建入口，不继续打开官方远控。
- 历史 E2E 变量保留兼容读取；新名优先，同一有效值贯穿 runner/build/Main/Renderer。测试名字兼容不作为产品配置默认。

## 范围限制

未调用生产发布、未修改正式用户 profile、未进行真实官方账号登录。源码默认地址和本地 HTTP/WS 夹具通过，不等于部署后的 DNS、云端资源、OIDC 或真机网络已验收。最终构建/测试执行结果和未覆盖平台见 validation-report.md。
