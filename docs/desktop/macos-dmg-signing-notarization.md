# macOS DMG Signing And Notarization

## 背景

macOS release DMG 是用户从浏览器下载后直接交给 Gatekeeper 评估的最终分发物。3.1.2 曾出现 DMG 已经通过 `notarytool` 并执行 `stapler staple`，但 DMG 本体没有 Developer ID 签名的情况；带 Chrome quarantine 的下载文件会被 `spctl -t open/install` 判定为 `source=no usable signature`，导致部分用户安装失败。

## 目标

- 当前桌面产物 `Mikiko.app` 由 electron-builder 使用 Developer ID Application 签名；
  `glm/tools` 的 Mach-O 在 afterPack 中预签名，主 App 封印及 DMG/ZIP 封装前完成。
- 最终 DMG 在提交 Apple notarization 前必须单独执行 Developer ID `codesign`。
- DMG 公证完成并去掉 `.unnotarized` 后，必须通过 `codesign`、`stapler validate` 和 `spctl -t open` 验收。
- 最终 `ZCode.app` 及其包内 Helper、安装后的用户级 Helper 必须分别通过 `codesign --verify --deep --strict` 和 `spctl -a -vv -t exec` 验收；两个 Helper 还必须通过本地 `xcrun stapler validate`，确认签名未被重新覆盖后 staple 仍对应最终 bundle。
- 正式 tag 发布禁止上传 `.unnotarized.dmg`；测试、sandbox 和 MR 链路可以保留未公证产物用于排查，但不得进入正式 release。

## CI 流程

从 v1.1.3 起，正式发布已拆分为构建归档、公证和后处理。实际恢复命令、30 天 artifact 保留期及各类失败是否需要重打，见 [发布恢复指南](release-recovery.md)。`scripts/notarize-macos.sh` 保留给一次性本地操作，正式 Actions 使用可恢复状态机。

以下描述签名与验收规则；正式 job 编排以恢复指南及 workflow 为准。

1. `.github/workflows/release-desktop.yml` 创建临时 keychain，显式设置 21600 秒超时，
   解锁并导入 Developer ID p12；通过 `CSC_KEYCHAIN` 指定签名钥匙链，job 结束时清理。
   默认的 300 秒锁定会早于 CI 首次签名，是 2026-10-19 签名挂起的主要排查依据。
2. `pnpm bundle:desktop -- --os mac --arch <arm64|x64>` 整理资源，预签 `glm/tools`
   原生文件，再由 builder 签 Electron/主 App，生成 DMG、ZIP 和更新清单。所有代码
   都需要安全时间戳和 hardened runtime；不能仅给最外层 DMG 添加时间戳。
3. `bash scripts/notarize-macos.sh packages/desktop/dist/*.dmg` 校验/补签最终 DMG，
   提交 Apple 并检查 JSON `status=Accepted`，之后 staple 和验收。该阶段不再重签 App
   或重建 DMG，避免 App、ZIP 和镜像内容不一致。
4. staple 会改变 DMG 字节；`refresh-macos-artifact-metadata.mjs` 更新对应清单哈希、
   大小和已存在的 DMG blockmap，保留 ZIP 内容与哈希。公证脚本验收所有现存架构 App。
5. 只有成功的 build job 才上传 installers；正式 tag 流程再发布 GitHub Release 和更新 feed。
   手动 `mac-only=true` 只验证两个 Mac 架构，不发布 release/feed。

行为规则与回归场景见 `specs/desktop/macos-signing.md`。

## Computer Use Helper 的独立签名与架构约束

`ZCode Computer Use.app` 虽随主 app 打包并在运行时复制到用户目录，仍是独立的 TCC 责任主体（bundle id
`dev.zcode.cua-helper`），必须与主 app **分开**签名，才能在系统里拿到属于自己的 Accessibility /
Screen Recording 授权条目。相关约束：

- **Helper 随 ZCode.app 交付，但作为独立 bundle 运行。** 发布包中的来源固定为
  `ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`；产品安装器校验后把它复制到
  `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`。不接受网络下载、`/Applications`、
  `~/Applications` 或 `ZCode.app/Contents/Library/Helpers` 作为产品兜底；来源缺失必须 fail-closed。
- **Helper 是独立 bundle，但复用 ZCode 的发布身份。** 独立 Helper 发布链路必须用
  `build/entitlements.helper.plist` + hardened runtime 签成 `dev.zcode.cua-helper`；签名身份仍使用与
  `ZCode.app` 相同的 Developer ID Application team/identity，不需要额外证书或额外 Apple 账号成本。同一
  release payload 内的 `ZCode.app` 与 `ZCode Computer Use.app` 必须走同一次 notarization/staple 验收链路；
  验收通过后，Helper 可以作为独立 `.app` 被安装器/脚本拷贝到
  `${ZCODE_HOME:-$HOME/.zcode}/computer-use/`。ZCode.app 只负责发现、LaunchServices 启动、health check，
  以及给 MCP 子进程注入随机 socket/token。
- **helper 主可执行必须是 SEA Mach-O。** `scripts/build-cua-helper-app.mjs` 用 Node SEA 把 helper 入口
  注入到一份拷贝的 Node 可执行里（替换旧的 shell wrapper），签名/公证前必须已是 Mach-O。
- **plain-node ABI 的 `ax_native.node` 必须先编好。** SEA helper 运行时用内嵌 Node（非 Electron）加载
  pinned `@zcode/zcode-cua/build/Release/ax_native.node`，因此需要 **plain-node ABI**（node-gyp rebuild，
  而非 `@electron/rebuild` 的 Electron ABI）。`@zcode/zcode-cua` 已加入 `pnpm-workspace.yaml` 的
  `allowBuilds`；独立 Helper 构建/验收必须显式检查该统一 addon 存在并可加载。
- **跨架构（x64 在 Apple Silicon runner 上打包）。** 打包进程的 `process.execPath` 在 Apple Silicon runner
  上是 arm64 Node，若 x64 job 不另行指定 Node，SEA helper 会被打成 arm64。`build-cua-helper-app.mjs` 的
  `assertHelperSeaBaseNodeArch` 会在 SEA 组装前 fail-closed，并提示：为 x64 job 设置
  `ZCODE_CUA_HELPER_NODE_PATH` 指向一份为目标架构编译的 SEA-capable Node，并为目标架构编译
  pinned producer 的 `build/Release/ax_native.node`（目标 `--arch=x64`）。原生 arm64 job 无需额外设置。

## 本地无 Developer ID 的 Helper 调试

开发机没有 Developer ID / notarization credentials 时，仍然可以用真实 ZCode App 跑
Helper-owned CUA 链路，但必须显式标记为本地 dev，不得当作 release 证据：

1. 本地构建 `ZCode Computer Use Dev.app`，并安装到
   `${ZCODE_HOME:-$HOME/.zcode}/computer-use/dev/ZCode Computer Use Dev.app`。
2. 从终端启动 ZCode App，并只在该进程环境里设置：
   `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`。产品 Helper resolver 正式版与本地/dist 构建默认启用；
   仅显式设置 `ZCODE_CUA_PRODUCT_HELPER=0|false|off` 才关闭。
   desktop 会把该确定性的本地路径作为 bundled source 注入 utility host；缺失时直接失败，
   不会回退网络下载。
3. ZCode.app 仍然通过 LaunchServices `open -n -g <Helper.app> --args --socket <path> --token-file <path> --launcher-pid <pid>`
   拉起外置 Helper，所以 macOS TCC 授权主体仍是 Helper 本身。产品路径**只接受 launcher 现签的一次性
   `--token-file`**（`helperMain` 会拒绝无 token-file 的产品 broker），并要求 `--launcher-pid` 做对端进程树
   校验；`--token` 仅用于显式本地 dev fallback，不应作为产品验收路径。

该模式只放宽 Developer ID TeamIdentifier 和 Gatekeeper/notarization 检查；bundle id、
版本、架构和 Mach-O 结构仍然必须匹配。缺失或结构不匹配时不会下载或替换正式 Helper，
而是 fail-closed。ad-hoc/unsigned Helper 的 TCC 身份不稳定，重建后可能需要重新授权；
正式验收仍必须使用签名、公证、staple 后的 Helper。

## 验收命令

```bash
codesign --verify ZCode-<version>-mac-<arch>.dmg
xcrun stapler validate ZCode-<version>-mac-<arch>.dmg
spctl -a -t open --context context:primary-signature ZCode-<version>-mac-<arch>.dmg
```

安装后最终验收主 app 与外置 Computer Use Helper：

```bash
pnpm run doctor:macos-release -- "/Applications/ZCode.app"
ZCODE_CUA_REQUIRE_HELPER=1 pnpm run doctor:macos-release -- "/Applications/ZCode.app"
```

该命令会依次执行：

```bash
codesign --verify --deep --strict "/Applications/ZCode.app"
spctl -a -vv -t exec "/Applications/ZCode.app"
codesign --verify --deep --strict "$HOME/.zcode/computer-use/ZCode Computer Use.app"
spctl -a -vv -t exec "$HOME/.zcode/computer-use/ZCode Computer Use.app"
xcrun stapler validate "/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app"
xcrun stapler validate "$HOME/.zcode/computer-use/ZCode Computer Use.app"
```

0.5.5 legacy：升级后旧 `ZCode CUA Helper.app` 目录可能仍然存在，但它不是当前安装的验收目标；
不要对旧路径运行 `codesign` / `spctl` 并把结果当作本版本 Helper 的发布证据。

脚本在成功路径捕获上述命令输出，只在失败时打印原始诊断，避免 `codesign` / `spctl`
的 verbose 内部属性明细污染正式打包日志。
