# 外部浏览器 External CDP：多实例挂载 + 设置集成 + 远控可用 + 菜单形态隔离

> 2026-10-07 定稿。基于外部贡献 `zcode-external-cdp-contribution`（基线 29628c9，v3.14.3）合入并按 Mikiko fork 适配。

## 背景与目标

Browser Use 原有 IAB（桌面内嵌）与 managed headless（CLI 自起）两种后端。本功能新增第三种 `external`：挂载用户自己启动、带 CDP 调试端口的真实 Chromium（登录态由用户真实登录并被复用，agent 不接触凭据）。fork 侧在此基础上完成四项适配：

1. 配置品牌化（`MIKIKO_*`）+ 内置默认配置（零配置可用）；
2. 配置集成进系统设置并支持运行期热更新（不重启生效）；
3. 手机远控（web-remote-replayable live 链路）可使用外部浏览器；
4. Windows 右键菜单与 macOS Finder 服务的三形态（production/preview/dev）键位隔离，文案统一为 Mikiko 品牌。

## 配置来源与优先级

外部浏览器配置的唯一解析者是 **desktop main**（单一写入路径；host 不读设置存储）：

```text
instances JSON 的生效值 =
  settings.externalCdpConfig（用户在设置页保存过，已通过校验）
    ?? process.env.MIKIKO_EXTERNAL_CDP（启动期显式覆盖/CI）
    ?? 内置默认 {"instances":[{"id":"default","endpoint":"http://127.0.0.1:9333"}]}

远控开关 =
  settings.externalCdpRemoteControlEnabled !== undefined
    ? 该值
    : process.env.MIKIKO_EXTERNAL_CDP_REMOTE_CONTROL !== "0"
```

- `AppSettings` 新增字段（`packages/shared/src/protocol.ts` + zod schema）：`externalCdpConfig?: string`（instances JSON，undefined=未在 UI 配置）；`externalCdpRemoteControlEnabled?: boolean`（undefined=true，免迁移）。
- instances schema 与 CLI `--browser-instances` 完全一致（`parseExternalCdpConfiguration`，id 小写 slug ≤64、id/endpoint 唯一、空数组=禁用）。设置保存前 main 侧用同一解析器校验；非法值拒绝保存并在设置页提示。
- 内置默认的含义：9333 无监听时 loopback 立即连接失败、该实例从发现列表消失，IAB 与其他实例不受影响——「零配置，用户按默认端口起浏览器即可用」。默认开启等价于信任本机 9333 端口的占用者（首连 UUID 钉扎后锁定）；此边界与显式配置同级，设置页文案需说明。
- CLI 侧不读任何环境变量（维持贡献设计：`--browser-use=external --browser-instances`/`--browser-endpoint` 旗标）。

## 配置下发与热更新

- **启动注入（race-free）**：main 在 spawn window Host 时把已解析的最终值注入 host 进程 env：`MIKIKO_EXTERNAL_CDP`（instances JSON）与 `MIKIKO_EXTERNAL_CDP_REMOTE_CONTROL`（"0"/"1"）。host 装配时读一次作为初始配置（缺失时回退内置默认，保证任何路径下功能默认可用）。
- **运行期变更**：`HostMessageTypes.ExternalBrowserConfigChanged`（main → window Host），payload `{ config: string, remoteControlEnabled: boolean }`（main 已解析+校验的最终值）。触发点：设置同步（`syncImmediateAppSettings`）检测到两个相关字段变化 → 对所有存活 window host 广播。
- **host 侧热重建**：`createDesktopExternalBrowserControl` 包装器新增 `applyConfiguration`——关闭旧 registry（安全 detach：取消在途请求、generation 失效、不动用户浏览器/页面）、按新配置重建、清空已发现 ID 缓存。executor 引用稳定，已创建会话不感知；进行中的 external 命令按设计返回 `backend_unavailable`，agent 下次发现拿到新 generation，不重放写入。

## 会话可见性（含远控）

外部浏览器实例的可见/可执行判定（list、execute、生命周期 broadcast 三处统一）：

```text
allow(scope) = scope.sessionContext !== "cached"        // 回放/恢复上下文不得驱动活跃浏览器
            && (无 remoteSessionId || 远控开关开启)      // 手机远控 live 链路默认可用
```

- IAB 仍为默认后端；external 描述符追加在发现列表；失败实例不遮蔽健康实例与 IAB。
- 所有权键 = `workspaceIdentity(回退链) + sessionId`，不含 remoteSessionId——手机与桌面驱动同一 logical session 共享 owned pages，会话结束按既有语义清理。
- SDK 选择语义不变：精确 `cdp:external:<id>`；family 多成员拒绝；仅多 external 无其他后端时拒绝隐式 default/URL 选择。

## 菜单与服务三形态隔离（Mikiko 品牌）

| 形态                  | Windows 注册表键（HKCU Directory/Drive shell） | Finder workflow（~/Library/Services） | bundle id                                     | 菜单文案（zh）           |
| --------------------- | ---------------------------------------------- | ------------------------------------- | --------------------------------------------- | ------------------------ |
| production（打包）    | `ZCode.OpenInZCode`（保持既有安装不变）        | `Open in Mikiko.workflow`             | `dev.mikiko.app.finder-open-workflow`         | 在 Mikiko 中打开         |
| preview（打包）       | `Mikiko.Preview.OpenInMikiko`                  | `Open in Mikiko Preview.workflow`     | `dev.mikiko.app.finder-open-workflow.preview` | 在 Mikiko Preview 中打开 |
| development（未打包） | `Mikiko.Dev.OpenInMikiko`                      | `Open in Mikiko Dev.workflow`         | `dev.mikiko.app.finder-open-workflow.dev`     | 在 Mikiko Dev 中打开     |

- 形态由编译期 `ZCODE_PRODUCT_FLAVOR` + `app.isPackaged` 决定；安装/刷新只写自己形态的键，绝不删除或迁移其他形态。
- production 首次安装 Finder workflow 时清理本 fork 历史遗留的 `Open in ZCode.workflow`（避免 Services 菜单出现两项）；Windows production 键名沿用 `ZCode.OpenInZCode` 同理（改名会遗留孤儿菜单项）。
- 非 Windows / 非 macOS 的注册为 no-op；语言切换刷新沿用既有 locale-refresh 路径。
- 注：deep link scheme `mikiko://` 三形态共用（macOS 由系统决定唯一接收者），维持现状不改。

## 模型可见性（2026-10-09 补：Agent 自调度）

实测问题：用户让 Agent 操作「自己的浏览器」时，模型不知道应用具备 external CDP 能力，需要人为引导。能力描述分两层写入模型可见面：

1. **能力感知层（每个桌面会话稳定可见）**：`apps/zcode-cli/packages/core/src/context/sections/desktop.ts` 的 `# Mikiko Desktop Context` 新增 `### Browser automation` 小节——声明 iab 之外可挂载用户自启 Chromium（默认实例 `cdp:external:default` @ `http://127.0.0.1:9333`，设置页可加多实例、热更新）；发现入口唯一 `agent.browsers.list()`；**列表无 `cdp:external:*` ⇔ 端口未监听，应引导用户带 `--remote-debugging-port=9333` 启动浏览器后重新发现，而不是判定不支持**；外部实例只能按精确 id `get("cdp:external:<id>")` 选择。该段 cacheHint=stable，不伤 prompt 缓存。
2. **操作细节层（动手前阅读）**：`browser-use-plugin/skills/control-browser/SKILL.md`（frontmatter description 提及外部 Chromium；正文外部段补默认端口/缺席引导/热更新 backend_unavailable 重试/登录态复用与永不关浏览器）与 `docs/overview.md`（`browser.documentation()` 输出补「不在列表 ⇔ 端口未监听」）。插件资产变更需同步升版三处（package.json、`.zcode-plugin/plugin.json`、`official-plugin-definitions.ts`）才会重 seed 官方插件缓存（0.5.1 → 0.5.2）。

生效链路：改 `apps/zcode-cli` 源码/插件资产后必须跑 `node scripts/build-desktop-agent-cli.mjs` 重建 bundled-agents（dev 验证），安装版随正式发版生效。

## 验收场景

1. 零配置：不设 env、不在设置页配置 → 发现列表含 `cdp:external:default`（9333 有浏览器时可见可操作；无监听时不可见，IAB 正常）。
2. 多实例：设置页配置 work-a/work-b → 热更新后（不重启）发现列表立即反映；改配置期间在途命令报 `backend_unavailable`，agent 重新发现后恢复。
3. 远控：手机 live 会话发现列表含 external 实例，可精确选择执行；`sessionContext="cached"` 上下文不可见；关闭远控开关后手机侧不可见，桌面侧不受影响。
4. 安全语义回归：贡献补丁原有 6 个集成测试全绿（macOS 实跑）——endpoint 校验/握手拒绝/页面所有权/安全 detach/generation/stale 拒绝。
5. 菜单：Windows 三形态键互不覆盖（注入假 registry runner 断言）；macOS 三形态 workflow 名称/bundle id/文案正确且清理遗留 ZCode.workflow；非目标平台 no-op。
6. 设置页：实例管理以整页子视图承载（像「新建钩子」一样接管「浏览器」设置区，面包屑
   「设置 / 浏览器 / 外部浏览器实例」返回摘要）；摘要页只保留远控开关与实例状态两行常规
   配置项（分隔符/排版与其他配置一致）；空实例列表展示虚线空态（含添加入口与「保存空
   列表=禁用」说明）；页面文案为一句话正式用途说明（无人称代词），字段说明与填写建议
   收纳在各表头的信息图标 hover tooltip；实例增删改、非法 id/endpoint 行内红框+保存拦截
   提示；「恢复默认」重置为内置默认；保存/恢复默认后执行写后回读校验（settingService.get
   对比落盘值），不一致时提示「后台服务进程版本过旧，需完全重启 App」并停留在编辑页——
   用于暴露 host 进程内联旧 zod schema 剥离新字段的场景（改 appSettingsSchema 后必须
   重启 host，Cmd+R 刷新窗口不会重启 host 工具进程）。

## 状态所有者

- instances/远控配置的解析与校验：desktop main（`externalCdpSettings.ts`）；落盘沿用 `mainSettingService`。
- external 连接/页面所有权：host 内 registry（贡献补丁语义不变）。
- 设置 UI 只持有编辑态草稿；保存走 `useSettings.update` → 落盘 + SyncAppSettings → main 解析推送。
