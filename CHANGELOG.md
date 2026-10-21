# Changelog

## [Unreleased]

### 🛠 修复

- 修复Computer Use已开启但会话没有原生工具的问题，并修复网关在插件宿主下启动后断开的问题。
- 修复智谱官方账号调用模型时误走自建服务导致404的问题，恢复官方CodingPlan模型网关。
- 修复 macOS 更新安装时，Computer Use 随包文件只读导致安装器失败的问题，并在签名前检查资源权限。

## [1.1.4](https://github.com/FatBallFish/ZCode/compare/v1.1.3...v1.1.4) (2026-10-21)

### ✨ 新增

- 支持 Mikiko 账号登录、设备管理和手机直接连接电脑，继续使用电脑上的项目与会话。
- 完善项目、会话和插件体验，整合上游新功能及修复，并保留 Mikiko 的定制能力。
- macOS 14 及以上可启用 Computer Use，观察应用窗口并操作控件、输入和滚动；拖拽会移动真实鼠标。

### 🛠 修复

- 修复升级后项目列表为空的问题，保留原有项目、置顶会话和任务归属。
- 恢复智谱账号套餐、额度及可用模型查询。
- 修复侧栏按钮重复、手机连接后白屏，以及新窗口插件列表无法加载的问题。
- 修复文档、PDF、表格等插件无法连接的问题；登录智谱账号后可使用配套图片搜索。
- 修复新用户首次为第三方插件授权时无法打开登录流程的问题。
- 改善交互组件在不同窗口间更新状态的可靠性。
- 修复官网 Intel Mac 下载选择和安装包断点续传问题。

### ⚡ 优化

- 语音整理使用与会话一致的模型选择方式。
- 统一应用进程、配置与忽略文件的 Mikiko 品牌命名。

### 💻 下载选择

- Apple Silicon（M 系列）选择 `mac-arm64`，Intel Mac 选择 `mac-x64`。
- Windows 按设备选择 `win-x64` 或 `win-arm64`；Linux 提供多种安装包。

## [1.1.3](https://github.com/FatBallFish/ZCode/compare/v1.1.2...v1.1.3) (2026-10-19)

### 问题修复

- 改善 Mac 安装体验：Apple Silicon 与 Intel 安装包均使用 Apple Developer ID 签名并完成公证，支持直接安装。

## [1.1.2](https://github.com/FatBallFish/ZCode/compare/v1.1.1...v1.1.2) (2026-10-15)

本次主打**应用换肤**与更完整的**会话独立窗口**，并修复一批使用问题（详细说明见 [更新日志口径](specs/release/changelog-audience.md)）。

### 新增功能

- **ui:** 应用主题皮肤——内置 6 套明暗双模式皮肤 + 自定义主题（壁纸/颜色/模糊压暗）+ 一键按壁纸配色 + 主题导出分享与导入 ([94bb2cb7](https://github.com/FatBallFish/ZCode/commit/94bb2cb7)、[9da9515b](https://github.com/FatBallFish/ZCode/commit/9da9515b))
- **desktop:** 会话独立窗口功能完整化——文件预览/内置浏览器/终端/辅助对话等面板均在独立窗口内可用，关闭时浏览器标签自动迁回主窗口 ([c2502896](https://github.com/FatBallFish/ZCode/commit/c2502896)、[97c7f3b6](https://github.com/FatBallFish/ZCode/commit/97c7f3b6)、[7cac8c64](https://github.com/FatBallFish/ZCode/commit/7cac8c64))

### 问题修复

- 电脑睡眠唤醒后打开会话报「SQLite startup failed」且无法恢复——现自动恢复 ([7cac8c64](https://github.com/FatBallFish/ZCode/commit/7cac8c64))
- 已关闭的会话独立窗口在最小化/唤醒后重新出现 ([7cac8c64](https://github.com/FatBallFish/ZCode/commit/7cac8c64))
- 浅色模式用户启动时闪一下深色界面 ([94bb2cb7](https://github.com/FatBallFish/ZCode/commit/94bb2cb7))
- 会话独立窗口标题未靠左、辅助对话按钮无反应、终端开关联动输入框位置 ([32423b47](https://github.com/FatBallFish/ZCode/commit/32423b47)、[3a642930](https://github.com/FatBallFish/ZCode/commit/3a642930)、[b94f423c](https://github.com/FatBallFish/ZCode/commit/b94f423c))
- 一批自测细节：宠物大小滑块、语音整理标点动画、日志导出脱敏、模型切换与会话列表高亮等 ([1cbd5c13](https://github.com/FatBallFish/ZCode/commit/1cbd5c13)、[1f780a42](https://github.com/FatBallFish/ZCode/commit/1f780a42)、[fbbf425c](https://github.com/FatBallFish/ZCode/commit/fbbf425c))

## [1.1.1](https://github-personal/FatBallFish/ZCode/compare/v1.1.0...v1.1.1) (2026-10-12)

### Bug Fixes

- **i18n:** 补设置「记忆」分区标题文案（settings.memory.title 从未定义，侧栏显示原始 key） ([93337b3](https://github-personal/FatBallFish/ZCode/commit/93337b30c565d87f4f2718b87833d4f72d82b727))

- **mikiko-cloud:** client/configs 读取与默认值逐组合并（存量 KV 缺新字段时补齐） ([63af89a](https://github-personal/FatBallFish/ZCode/commit/63af89a29a2da9f2ad3d632206cfcc1919ad71d3))

- **settings:** ChatGPT 版本覆写支持清空（空串归一回 undefined） ([58214a7](https://github-personal/FatBallFish/ZCode/commit/58214a72b0c61464cca3fdaa41c9762006827bc2))

## [1.1.0](https://github-personal/FatBallFish/ZCode/compare/v1.0.8...v1.1.0) (2026-10-12)

### Features

- **desktop:** 「去开启」补 TCC 请求写入麦克风列表 + Windows 隐私设置深链 ([b52535b](https://github-personal/FatBallFish/ZCode/commit/b52535b65850f067194429f4e5250265abf598fb))

- **desktop:** 会话语音输入（本地 sherpa-onnx ASR + 可选 LLM 语义整理） ([a22aa45](https://github-personal/FatBallFish/ZCode/commit/a22aa457d243d7d8d5e2f965d8dded300d8a86ac))
  - shared：voice 协议与内置模型清单（SenseVoice/Zipformer/Qwen3-ASR，sha256 校验下载）、IPC 通道、设置字段、voiceInput 快捷键命令
  - desktop main：VoiceService（引擎 utilityProcess 懒加载/互斥/5 分钟空闲卸载）、模型下载管理、会话所有者；CJS worker（VAD 分段伪流式/真流式）
  - renderer：麦克风入口 + 语音浮窗（波浪动效/ESC 取消/实时文案）、设置页语音输入分区（模型卡/语义整理 ModelConfigSelect 复用/快捷键跳转/引擎释放）
  - 语义整理走 workspace/generateText（失败降级原始转录）；模型文件按需下载至 ~/.mikiko/v2/voice-models
  - 打包：sherpa-onnx 平台子包按目标裁剪 + asarUnpack；THIRD-PARTY-NOTICES 增补（Apache-2.0）
  - 测试：shared 清单 5、desktop 服务 8（含下载校验失败/空闲卸载/切换模型）、ui 回填 4；worker 真机集成验证通过（SenseVoice zh/en 实测识别）

- **desktop:** 语音输入错误态可关 + 输入设备选择 + macOS 麦克风权限引导 ([dd722d2](https://github-personal/FatBallFish/ZCode/commit/dd722d2e281189cacd3eec48080e6c48005dbc87))
  - 输入设备选择（spec §3.4）：设置页下拉枚举 audioinput，首项「使用系统默认」，
  - 麦克风权限（spec §3.5，macOS TCC）：开录前 voiceEnsureMicPermission 预检
  - 新增 IPC：VoiceGetMicPermissionStatus/VoiceEnsureMicPermission/
  - 设置页超 max-lines：模型卡列表拆出 VoiceModelCardList 组件

- **mikiko-cloud:** Codex 客户端版本号定时同步 GitHub releases ([12076c8](https://github-personal/FatBallFish/ZCode/commit/12076c811cad4fc59ba5704b6598439b2491d562))
  - worker 加 scheduled（cron 每 6h）从 openai/codex releases 取 rust-v 前缀非
  - 默认 codex.clientVersion 0.146.0 → 0.162.1（shared fallback 同步升级）
  - seed modelRules 补 .\*gpt-6 系 modelMatch（ctx 1050000，对齐既有 gpt-5.6 形态）

- **services:** 迁移支持 Codex CLI 历史会话导入（~/.codex/sessions rollout，双来源扫描合并 + migrationSource=codex） ([ef510b7](https://github-personal/FatBallFish/ZCode/commit/ef510b7945c7cc157276d5d4ab421e0ef2cf330e))

- **shared/services:** ChatGPT OAuth 账号体系（协议/服务栈/CLI 通道/动态 provider） ([f2d33ef](https://github-personal/FatBallFish/ZCode/commit/f2d33ef9a15f160686958be2ef3ca43f1d7e11d3))
  - shared：PKCE OAuth、JWT/ID token claims、usage/限流头归一化、账号记录与视图类型、
  - provider：chatgpt-family 分组、account:chatgpt:{id} 动态 provider 信封 schema 与
  - services：ChatGPTAccountService 全套（授权流程/sub2api 导入/enrich/令牌 5min 惰性
  - CLI adapters：/codex/responses 走 curl 子进程通道（undici 默认 TLS 指纹被上游伪 401
  - spec specs/desktop/chatgpt-oauth.md 全量（含 §17 实测记录）

- **ui:** ChatGPT 账号设置页与会话集成 ([534d3ee](https://github-personal/FatBallFish/ZCode/commit/534d3ee0d7c2d96266978527d63db2d8bc6bbb8a))
  - 设置-模型设置：ChatGPT 分组（账号条目/详情页：订阅/额度窗口/重置次数/令牌操作/
  - 账号详情模型列表复用 ProviderModelsSection（spec §9.2）：同步模型支持编辑/启停/
  - 会话：模型选择器账号分组（名称+ChatGPT badge）、composer 旁侧 ChatGPTContextUsage
  - ChatGPT 设置分区：Codex UA 模拟开关（版本覆写）与 Fast/Flex 服务档位
  - 左下角账户菜单 ChatGPT 区块；trigger 对 chatgpt 账号 provider 只显示模型名

- **ui:** 设置页信息架构整理与用量统计扩展（spec settings-usage-reorg） ([5d5df83](https://github-personal/FatBallFish/ZCode/commit/5d5df831036bc8355b3c26d34a3b619a43167af9))
  - 移除系统设置独立「Mikiko 网关」菜单（模型设置内已有站点管理，Sub2ApiSection
  - 中转站用量/套餐两页合并：套餐（余额 + 订阅窗口）置用量页顶部；多站点全量
  - Tab 顺序：应用用量 → 智谱个人/团队套餐 → 中转站用量 → ChatGPT 用量
  - 新增 ChatGPT 用量 Tab：账户信息（订阅/credits/5h·7d 窗口/重置次数）+

- **ui:** 项目行菜单（完整路径/打开目录/复制路径/置顶）+ 右键菜单 + 已置顶区项目→会话层级 ([639cd52](https://github-personal/FatBallFish/ZCode/commit/639cd523a7f6ab569e74a62b02bfb64018ddeefd))

- **usage-stats:** App 用量统计支持按 provider 过滤（model_usage.provider_id） ([7f4009a](https://github-personal/FatBallFish/ZCode/commit/7f4009a6234b55f58225a2b32d0503daf8c331f9))

- **worktrees:** 新建工作树物化 .agents 项目资产 + 会话配置继承 + 起始分支搜索过滤 ([0b63fb6](https://github-personal/FatBallFish/ZCode/commit/0b63fb69b0bae5dc59d202a3649f72a342c4b510))

### Bug Fixes

- **desktop:** dev bundle 改写 Info.plist 后 ad-hoc 重签名（修 TCC 麦克风授权死局） ([b1ced52](https://github-personal/FatBallFish/ZCode/commit/b1ced52c18e1b690944e1713d2caa302f2e17b25))

- **desktop:** 外部 CDP 不可达不再阻塞新会话（ambient 1.5s deadline + 连接失败 10s 负缓存 + abort 贯穿） ([b65bb69](https://github-personal/FatBallFish/ZCode/commit/b65bb69d37e2a7b384d42e796ad8ed39457a9e8a))

- **desktop:** 语音输入 Review 修复（P0/P1 全清 + VAD 分块喂入根修） ([36a059d](https://github-personal/FatBallFish/ZCode/commit/36a059d7b97e85be9964c16ec839659e3a668b84))
  - P0 startSession 失败路径的麦克风泄漏：mic 落定后立即 stopMic，begin 入口防御性先停旧麦
  - P1 worker 加载期 error 事件立即 reject waiter（原 120s 挂起）；disposeEngine kill 加载中的 child（孤儿进程）
  - P1 startSession 整体串行化 + await 后复检 busy（并发双 worker/单槽 waiter 覆盖竞态）
  - P1 引擎 error 清理活动会话并复位 worker seq（原永久 busy）
  - P1 跨 VAD 分段拉丁边界补空格（英文粘连丢词）
  - 根修 VAD 分块喂入：acceptWaveform 按 windowSize=512 重切块（整帧直喂消费远慢于实时、partial 不出字；实测复现与验证）
  - partial 文本变化才发；全大写小写化收紧为 100% 大写；ESC 不吞对话框；engine-loading 按 preparing+model 过滤
  - 删除已选模型回落默认；模型卡展示来源与许可；下载占位同步注册；下载失败恢复空闲卸载排程
  - 回填折叠换行单段追加（markdown 与编辑器不漂移）
  - 新增 3 个时序测试（加载期错误/并发 start/会话中错误）；spec 同步 VAD 喂入约束与 busy 行为

- **desktop:** 语音输入真机 E2E 修复（feed 崩溃/external buffer/浮窗锚定/麦克风点亮） ([7ebac2a](https://github-personal/FatBallFish/ZCode/commit/7ebac2a5581a0da78b8e6c44ccbac62246d49672))
  - feedAudio 给 utilityProcess.postMessage 传 ArrayBuffer transfer 列表会同步抛
  - worker 内 VAD front() 默认返回 N-API external buffer，回喂 acceptWaveform 抛
  - 浮窗固定 bottom-36 在草稿态压住 composer 下方的建议 chips 区，改为运行时测量
  - 麦克风监听态仅 text-brand 色调在浅色主题下不可辨，改为品牌色填充 + 呼吸动画
  - ESC 守卫对合成事件 target（非 HTMLElement）调用 closest 抛 TypeError，补
  - useVoiceInputController 超 max-lines，按 desktopVoiceService 同款豁免注明单一所有者

- **desktop:** 麦克风授权真根因修复（Electron 41 API 名 + audio-input entitlement） ([7d52f52](https://github-personal/FatBallFish/ZCode/commit/7d52f526744bf6259c5c0bf400cbd4254fe374a0))
  - 正式包 entitlements（主 + inherit）补 audio-input，否则正式版语音输入
  - 从 ZCode.app 内启动的 dev 实例弹框被宿主连坐禁掉——验证授权流程须从

- **ui:** 整理模型下拉按供应商分组展示（showProviderLevel=false 只渲染智谱账号组） ([6f8c75f](https://github-personal/FatBallFish/ZCode/commit/6f8c75fa4d22abde1aeff26b2db3a91f64824a1a))

- **ui:** 设置页三处模型选择器补 ChatGPT 账号分组标签（语音输入/子代理/工作流弹层） ([10cda2a](https://github-personal/FatBallFish/ZCode/commit/10cda2adde0fd6f68cbfb68786e60f022cc08530))

- **ui:** 语义整理生效（思考档位）+ 整理模型候选补全 + 分割线/已选名显示 ([011a89e](https://github-personal/FatBallFish/ZCode/commit/011a89efe5a997e4e578a8389e38b6040efad421))

- **ui:** 语音输入设备下拉默认项使用哨兵值（Radix SelectItem 禁止空串 value） ([0b505ac](https://github-personal/FatBallFish/ZCode/commit/0b505ac633d9742086af3c5d5d128858182c101c))

- **ui:** 顶栏文件管理器条目改主题化 FolderOpen 单色图标（explorer.exe 全彩位图在深色模式突兀） ([d986c97](https://github-personal/FatBallFish/ZCode/commit/d986c976d0cdab87a075ceb7c0145c4c19d73e9e))

### Documentation

- **specs:** 语音输入本地模型调研报告（sherpa-onnx + SenseVoice/Qwen3-ASR 选型与集成方案） ([3c63262](https://github-personal/FatBallFish/ZCode/commit/3c632628afed6d110c639ac20c34a5c72b865781))

### Refactorings

- **desktop:** 桌宠拖拽改 main 锚点式驱动（修混合 DPI 跨屏错位/瞬闪，60Hz 节流） ([45e730a](https://github-personal/FatBallFish/ZCode/commit/45e730a694d50cc413e2021e5f82a1a6263b428e))
