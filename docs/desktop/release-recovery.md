# 正式版本发布、公证等待与故障恢复

适用于 `.github/workflows/release-desktop.yml` 从 v1.1.3 起生成的产物。
目标是复用同一份签名包和同一个 Apple submission，避免因为 Actions 等待结束而重复构建。

## 正常发布

更新根 `package.json` 版本、CHANGELOG 与 `.github/release-notes/<tag>.md`，提交并推送代码，
再创建和推送新 tag。正式 tag 不移动、不删除重打。

```bash
git tag -a v1.1.3 -m 'Release v1.1.3'
git push origin v1.1.3
```

工作流先生成 Windows x64/arm64、Linux x64 和 macOS arm64/x64 安装包，以及 relay 部署包。
Mac build 内签好 App 和 DMG，再将完整输入以 tar 归档；framework 符号链接、权限均保留。
独立 notarize job 下载原包、校验哈希、提交或找回已有提交，单次最多等待 20 分钟。
`Accepted` 后才 staple、验签、重建带 App 票据的 ZIP，并上传可发布的 installers。

| Artifact                                                 | 用途                                                                | 保留期 |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| `signed-mac-arm64` / `signed-mac-x64`                    | 公证前完整签名原包及 `signed-bundle.json`；恢复的唯一原始输入       | 30 天  |
| `notary-state-<原run>-<架构>-<本次run>-<attempt>-intent` | 调用 Apple 前保存的提交意图，防止响应丢失后盲目重交                 | 30 天  |
| `…-submitted` / `…-waited`                               | submission ID、原包哈希、版本、检查时间与状态；恢复自动选择最新记录 | 30 天  |
| `installers-mac-<架构>`                                  | Accepted、staple、解压验签全部通过的 DMG/ZIP/清单/差分数据和证据    | 30 天  |
| `installers-win-*` / `installers-linux-x64`              | 对应平台完成的安装包                                                | 30 天  |
| `relay-server-deploy` / `relay-cloudflare-deploy`        | 已完成的部署资源                                                    | 30 天  |

`release-verification.json` 与 GitHub Release 上的 `notarization-mac-<架构>.json` 记录
原始 run、代码 SHA、submission ID、最终文件哈希和验收结果。它们可用于确认后处理没有偷换版本。

## 公证超时后继续执行：不要重新打包

**Apple 继续处理已接收的提交。** 20 分钟只是客户端等待上限，不会撤销 submission。
notarize job 会保存 `state.json` 后以未完成状态结束；Release/feed 被阻止。

记下第一次 tag 构建的 run ID（下称 `原始run`）。即使恢复多次，也始终填这个 ID，
不要把中间恢复 run 当成新的原始构建。不要直接再次手动运行一个不带 source-run-id 的完整构建。

```bash
# 查看原始 tag 构建的 ID
gh run list --workflow release-desktop.yml --branch v1.1.3

# 从原包续查/收尾/发布；123456789 是例子，替换为第一次构建的真实 run ID
gh workflow run release-desktop.yml --ref custom_main \
  -f source-run-id=123456789 \
  -f release-tag=v1.1.3
```

恢复入口会：

1. 验证原始 run 确实属于同一版本 tag，跳过 build 和 relay。
2. 下载原始 `signed-mac-*`，验证 manifest 的版本、提交 SHA、架构、原始 run 和文件哈希。
3. 自动下载同一原始 run/架构的最新 state。已有 ID 只调用 `info/wait`，不会 submit。
4. Accepted 后再次执行幂等后处理，并从原始 run 下载已完成的 Windows/Linux/relay 产物。
5. 上传/补齐 GitHub Release 资产和更新 feed；不删除已有 Release。

如果仍 `In Progress`，稍后用**相同命令**恢复即可。推荐至少隔 20–30 分钟查询，
不需要占着 macOS runner 连续等待几小时。若任务仍在运行，相同 tag 的新运行会排队，
不会取消当前任务或并发重复提交。

`--ref custom_main` 使用当前修复后的工作流脚本，但安装包始终来自原始 run；不会编译当前分支。
工作流恢复不会把新源码混进旧版本包。若使用其他维护分支，确保它包含恢复脚本。

## 哪些失败需要重新构建

| 场景                                                       | 首选恢复动作                                        | 重新构建           | 重新公证                             |
| ---------------------------------------------------------- | --------------------------------------------------- | ------------------ | ------------------------------------ |
| Apple `In Progress`、20 分钟等待超时                       | `source-run-id` 恢复原提交                          | 不需要             | 不需要                               |
| runner 在等待时丢失、Actions 总超时                        | 原包已归档；恢复原 ID                               | 不需要             | 不需要                               |
| info/wait 临时网络错误、Apple 5xx                          | 修复网络后恢复；保持原 ID                           | 不需要             | 不需要                               |
| Apple 凭据失效/401/403                                     | 更新同一 Team 的 secrets 后恢复                     | 不需要             | 不需要                               |
| submit 响应丢失、没有拿到 ID                               | 恢复按含 SHA-256 的上传名查询 history，找回已有 ID  | 不需要             | 不自动重交                           |
| 有提交意图但 history 暂无匹配                              | 等待 history 可见后恢复；人工核实 Apple history     | 不需要             | 确认从未接收才考虑重交同一原包       |
| history 同名出现多个 ID                                    | 人工检查各 ID，不自动猜测或再提交                   | 不需要             | 不需要                               |
| `Accepted` 后 stapler 临时失败/票据未传播                  | 稍后恢复，重新 staple 同一包                        | 不需要             | 不需要                               |
| 本地验签成功但 Gatekeeper 暂时查不到票据                   | 保留 Accepted ID，排查网络/票据后恢复               | 不需要             | 不需要                               |
| ZIP 压缩、blockmap 或更新清单生成失败                      | 修复后处理脚本后恢复，重建 ZIP/元数据               | 不需要编译         | 不需要                               |
| Upload installers 失败                                     | 原 run 的 Re-run failed jobs，或 source-run-id 恢复 | 不需要             | 不需要                               |
| Release 资产上传部分失败                                   | Re-run failed jobs；幂等补传，已有 Release 不删除   | 不需要             | 不需要                               |
| R2/feed/官网发布失败                                       | 只重跑失败的发布 job；使用现有 installers           | 不需要             | 不需要                               |
| Windows/Linux/relay 编译或打包失败                         | 原始 run 的 Re-run failed jobs，仅补失败 job        | 只补失败的平台     | 成功 Mac 不需重交                    |
| Mac 编译失败、签名失败，尚无完整原包                       | 修复源码/签名后补该 Mac build；成功平台保留         | 仅该架构           | 尚未提交则首次提交                   |
| Apple `Invalid`，日志指出缺签名、时间戳或 entitlement 错误 | 修正签名输入；至少重新签名和封装该架构              | 不一定重编译       | 字节/代码签名改变后需要新 submission |
| Apple 发现应用内容本身有问题                               | 修正源码并构建新版本                                | 需要               | 需要                                 |
| 原包哈希不匹配、损坏、串版本                               | 先重新下载同一 artifact；禁止篡改 state 绕过验证    | 原包无法找回才需要 | 仅新包需要                           |
| Artifact 过期/被删                                         | 从独立备份恢复精确原包及 state；无法找回才构建      | 视备份而定         | 原包完全一致且 ID 仍有效可继续       |
| 正式 tag 已发布后发现产品 bug                              | 发布新的补丁版本，不能移动旧 tag 混用产物           | 新版本需要         | 新版本需要                           |

公证拒绝日志可以直接读取，不要把 `Invalid` 当成等待超时：

```bash
# 本机使用同一 Team 保存的 keychain profile；CI 的认证使用 secrets
xcrun notarytool info <submission-id> --keychain-profile mikiko-notary
xcrun notarytool log <submission-id> --keychain-profile mikiko-notary
xcrun notarytool history --keychain-profile mikiko-notary
```

`notarytool` 进程退出 0 不代表通过，必须检查 JSON `status=Accepted`。
也不要关闭 `set -euo pipefail`：staple 或任一验收失败都必须阻止发布。

## 原始 run 的部分失败重试

```bash
gh run view <原始run>
gh run rerun <原始run> --failed
```

只有原始构建阶段确实失败才补相应 build。公证等待未完成优先用 source-run-id，
它显式跳过所有平台编译。若只是发布 job 失败，可仅重跑对应 job（job ID 可从 `gh run view --json jobs` 取得）：

```bash
gh run rerun <发布所在run> --job <失败job-id>
```

恢复时需要的 artifact 不能提前删除；30 天外长期排队或计划人工发布时，应先下载备份原包、
submission state 和全部平台产物。备份里不要包含证书私钥、应用专用密码或其他 secrets。

## 发布完成的判断

- GitHub Release `v1.1.3` 已公开，完整平台安装包及两份公证证据可下载。
- 两个 Mac `release-verification.json` 均为 Accepted，DMG 与 ZIP 都通过验收。
- 更新 feed job 成功，平台清单版本为 1.1.3，引用的文件和最终 SHA-512 相符。
- 原始 run 与任何恢复 run 的链接、submission ID 记录在发布验证文档中。

仅看到 Apple Accepted、某个 bundle job 成功，或 GitHub 上存在草稿 Release，都不是完整发布完成。
