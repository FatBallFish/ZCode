# Computer Use 构建可用性验证

范围：人工回归第 2 项的可用性误报。真实 producer 未提供，本次只修构建能力判定和 UI；不恢复私有 Helper、不修改签名/TCC、不执行个人系统授权。

## 确认原因

`packages/desktop/scripts/computer-use-producer.mjs` 实际读取当前安装得到 `installed:true, placeholder:true`。旧 GetCuaOsSupport 只检查 OS，会把满足版本要求的占位构建报告为 supported；设置页随后仍查询不存在的 Helper 并提供无效授权/重启入口。

## 修复

- tsup Main 使用既有唯一检测 owner 写入 `__MIKIKO_COMPUTER_USE_AVAILABLE__`，不另建环境变量或检测器。
- Main 的 `resolveCuaOsSupport` 明确返回 `build-unavailable`，shared union 同步；真实 producer 的 macOS 地板及其他平台规则保留。
- 设置页先读取能力事实，缺 producer 时显示中英文构建说明，并隐藏插件开关、授权及重启操作；不启动插件初始化和权限查询，焦点返回也不查询。已有旧平台缺命令/读取失败的兼容行为保留，不把 IO 故障错误标记为缺少 producer。

## 实际验证

- 先红：`/tmp/mikiko-cua-build-red.log` 和 `/tmp/mikiko-cua-ui-build-red.log`；Main 缺新状态/宏、UI 缺说明均可复现。
- 定向 Vitest 最终 **4 文件、35 项通过**，`/tmp/mikiko-cua-build-coverage-final.log`。包括真实 tsup define、esbuild 实际替换 true/false 后无参数覆盖调用、占位判定、UI 无权限 RPC、真实 producer/低 OS/旧平台兼容。
- V8 完整 statementMap：`/tmp/mikiko-cua-build-coverage/coverage-final.json`。整文件 lines **48.8%**（ComputerUseSection 大量既有授权/重启逻辑不在本次范围），Main resolver lines 100% / branches 80%；不宣称整文件 95% 门禁通过。编译宏 true/false 的行为另外经过实际 esbuild 产物调用，不能只靠源码行命中证明。
- 针对性 Lint 11 文件，0 错误/警告；默认架构检查当前为 0 违规，日志 `/tmp/mikiko-ui-2478-architecture.log`。
- 新 shared union 引入后初次 UI/Main 单包 noEmit 检查读取到旧 shared 声明而退出 2，日志 `/tmp/mikiko-cua-{ui,main}-typecheck.log`。父协作者更新 shared 声明后，两项针对性 noEmit 重查均实际退出 **0**，最终日志 `/tmp/mikiko-cua-ui-typecheck-final.log` 与 `/tmp/mikiko-cua-main-typecheck-final.log`；保留首次失败记录，不把它改写成通过。

浏览器：使用隔离 loopback Chrome fixture、真实 ComputerUseSection 与真实权限 hook，平台命令/权限服务端口及插件 store 为可计数夹具；不调用系统设置或真实 Helper。

**4/4 通过**：缺 producer 的浅色英文/深色中文、低版本 macOS、模拟真实 producer。缺构建页面仅查询一次能力，权限状态/授权/重启/插件初始化/开关调用全部为零；三次 focus 后仍为零；无按钮或 switch。低 OS 显示版本提示、模拟真实 producer 才查询权限。无 pageerror/外网请求。日志 `/tmp/mikiko-cua-build-browser.log`，截图与结构化证据 `packages/desktop/.e2e-artifacts/cua-build-availability/`。

后续限制：真实 producer/原生 Helper 来源仍需用户提供；这些测试不能证明系统权限授权、签名验证或实际 Computer Use 可用。日常 Dev 需要使用包含新能力宏的 Main 构建，不能仅依靠 renderer HMR 验证编译配置。

## 优先复用官方实现：只读可行性调查

用户要求先调查官方实现能否复用。调查只读取已安装资源、公开包元数据和代码签名信息；没有启动官方应用/Helper、发送任何官方 broker 请求、替换/重签文件、修改 TCC 或读取/复制凭据。

### 可复用组件与当前缺口

| 组件                | 本机证据                                                                                                                                                                                                                                                                                                                                         | 判断                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方主应用          | `/Applications/ZCode.app`：3.15.3（build 3.15.3.8237），bundle `dev.zcode.app`，官方 Team `8A5X4JJ39T`。                                                                                                                                                                                                                                         | 是已发布实现的调查依据，不导入/执行其整块 Main/Host 来冒充 SDK。                                                                                                              |
| 官方随包 Helper     | `Resources/cua-helper/ZCode Computer Use.app`：3.15.3，bundle `dev.zcode.cua-helper`，arm64，macOS 最低 12.0，Developer ID 官方签名；`codesign --verify --strict --deep` 未报错。配套 `ax_native.node` 也是 arm64。                                                                                                                              | 文件确实存在，架构适合当前 arm64 机器；存在不代表会接受 Mikiko 客户端，也未执行实际权限验证。                                                                                 |
| 官方缓存 Helper     | `~/.zcode/computer-use/ZCode Computer Use.app` 为 3.12.3；`dev/ZCode Computer Use.app` 为 3.11.2，均保留官方签名身份。                                                                                                                                                                                                                           | 不能按目录名把 dev 缓存当成允许任意客户端的通用开发 Helper。不得覆盖既有安装或借用其授权身份。                                                                                |
| 公开模型 SDK 包装层 | 官方插件包 0.6.4 的 `scripts/computer-use-client.mjs`，58154 bytes、MIT 包元数据；与当前仓库对应文件字节完全相同，SHA256 均为 `b76cc835c31e67912aa718ff0e208f69b02fbd4fe3cd1811f635730401202b02`。                                                                                                                                               | 已复用，无需拷贝。它依赖宿主注入的 `Symbol.for("zcode.node-repl.computer-use-bridge")`，本身不实现 native 操作。不能把包装层的 MIT 元数据外推到整块已发布应用/私有 producer。 |
| 实际执行 producer   | 当前 `@zcode/zcode-cua@0.6.5` 明确 `zcodeCuaPlaceholder:true`：`createComputerUseRuntime.execute` 固定返回 unavailable，`callBrokerMethod` 抛 unavailable，installer/native/server 工厂也是占位。官方 app.asar 中没有可独立导入的 `node_modules/@zcode/zcode-cua` 包，真实实现内联在 Main/Host bundle。公共 npm registry 查询该包返回 HTTP 404。 | 未发现可直接接入的真实、版本兼容、具备完整接口与可复用来源依据的 standalone producer/SDK。公开注册表没有该包不代表厂商私有渠道不存在。                                        |

SDK 包装层、Node REPL bridge 与 actual runtime 是三层：当前前两层已有代码，但最后一层固定失败。只把 Helper 路径指向官方应用、只替换 broker client 或只让权限徽章变绿，都不会让 `runtime.execute` 成为可用的执行链。

### 公开 IPC 形态与签名约束

对已发布包的静态检查确认：Helper broker 是 UNIX socket 上的 JSON-line request/reply；连接首先发送 `authenticate`，之后才发业务方法；公开客户端包含 `broker_info`，Host 客户端宣告 `clientApiVersion:3`。这提供了协议形态证据，尚不能替代完整的 frame/state/lease/执行协议及版本兼容合同。

Helper 二进制中的可读诊断与实现文本明确包含下列检查：同 uid、audit_token 客户端代码签名、允许 Team、负责/父进程签名；`--launcher-pid` 若不能验证为符合 ZCode 签名要求的进程会拒绝启动。生产 launcher requirement 绑定官方应用标识集合与官方 Team，peer requirement 也固定 Team。官方 Host 还校验 socket 的实际所有者 PID、Helper bundle/team 签名、运行路径和 build identity。Mikiko 的产品身份是 `dev.mikiko.app` / `dev.mikiko.app.preview`，不能假定通过这些检查。

因此，签名限制不是“用户授权了就能解决”的普通权限开关。当前没有一个已证明兼容、同时保留这些约束的隔离 adapter。调查没有设置任何不校验 peer、允许未签名客户端的开发绕过，也没有重签或修改官方文件。已经存在的 TCC 授权不能作为复制权限身份的理由。

### 最小接入计划与当前决定

1. 先取得厂商提供的真实 producer 分发包/SDK及其明确使用与分发条件，版本和公开类型覆盖当前 runtime、broker/server、frame 与会话合同。若需使用现有官方 Helper，厂商还须提供明确支持 Mikiko 应用/签名身份的兼容方案；不能通过改身份、绕过验签来代替。
2. 条件具备后，才能在既有 producer 公共入口后实现可选的隔离 adapter，保持 Host、会话、controller lease、状态/截图身份、possibly-sent 防重放和停止机制的原 owner。不得复制整块 Main/Host 内部实现或恢复大段来源不明依赖。
3. 先在本次拥有的隔离 profile/进程中验证签名、握手和只读健康检查，再验证受控目标上的实际工具请求、frame/state连续性、取消/重放边界及资源回收。权限状态正常和真实动作可执行必须分开验收。现有官方 Stable、缓存 Helper、凭据与系统授权保持原位。

当前决定：上述真实 producer 与受信兼容方案尚缺，因此不实施一个只有表面绿灯的 adapter，保留 `build-unavailable` 修复。可复用的公开包装层已经在仓库；官方 Helper 可作为后续兼容目标，但目前既不能凭其存在启用功能，也不能宣称 Computer Use 已恢复。

调查证据索引：`/tmp/mikiko-official-cua-bundle-index.json`、`/tmp/mikiko-official-app-asar-files.txt`、`/tmp/mikiko-official-cua-investigation-npm.json`。只读分析副本位于 `/tmp/mikiko-official-cua-investigation/`，未加入仓库、未导入执行。
