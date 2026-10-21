# v1.1.4 发布验收记录

验收日期：2026-10-21（北京时间）。**发布产物、双Mac公证、官网/更新通道及正式安装包Computer Use真实验收均已通过。**

## 发行身份

- 分支 `custom_main`；不可移动 tag `v1.1.4` 指向 `1780d0a988e02e854eb50f6605fa60122b8fbab1`。
- 唯一原始构建：[39547367291](https://github.com/FatBallFish/ZCode/actions/runs/39547367291)，全部构建、公证、发布和 feed job 成功；未重新构建、重签或补交公证。
- [公开 GitHub Release](https://github.com/FatBallFish/ZCode/releases/tag/v1.1.4)：非草稿、非预发布，29个资产。
- 后续仅服务恢复提交 `5187fa6b`、`651d6155` 已推送；未改变 tag 或桌面安装包。

## 公证与下载

| 架构  | Apple submission                       | 状态     | App/DMG staple | ZIP payload |
| ----- | -------------------------------------- | -------- | -------------- | ----------- |
| arm64 | `ef42256a-c0ae-42db-9bea-10571e7f4179` | Accepted | 通过           | 通过        |
| x64   | `0295971e-8854-4a33-86fc-7e514c4488c7` | Accepted | 通过           | 通过        |

公开 Release 的两份 notarization proof 均匹配原始 run、源提交和版本；Mac文件实际SHA256同时匹配proof及GitHub资产digest。正式arm64 ZIP已从公网下载并解压，父App `codesign --verify --strict --deep`、`stapler validate`再次通过。

10个安装包均完成实际下载，完整大小与SHA512匹配五平台stable manifest，SHA256匹配GitHub资产；HEAD及32字节Range（206、Content-Length、Content-Range）逐文件通过：

| 文件                               |    字节数 | SHA256（前16位）   |
| ---------------------------------- | --------: | ------------------ |
| Mikiko-1.1.4-mac-arm64.zip         | 242324240 | `7c32450835d2e335` |
| Mikiko-1.1.4-mac-arm64.dmg         | 243247448 | `3274b5dcf668269a` |
| Mikiko-1.1.4-mac-x64.zip           | 252258864 | `20406b5412b350ac` |
| Mikiko-1.1.4-mac-x64.dmg           | 253047651 | `11a349b3d7a7fb89` |
| Mikiko-1.1.4-win-x64.exe           | 186450221 | `1d30cbecb80c4425` |
| Mikiko-1.1.4-linux-amd64.deb       | 178346084 | `58033310f8b90936` |
| Mikiko-1.1.4-linux-x86_64.rpm      | 148191461 | `41fb67923a4cfd17` |
| Mikiko-1.1.4-linux-x64.pkg.tar.zst | 156620860 | `b20299767c292feb` |
| Mikiko-1.1.4-linux-x86_64.AppImage | 246497852 | `a2d0f77cc418a218` |
| Mikiko-1.1.4-win-arm64.exe         | 182069337 | `262165a93c4e7483` |

6份blockmap也完成实际下载、大小与完整SHA256对照；完整摘要、清单快照、URL及证据见[验收数据](./release-verification-v1.1.4.json)。首次Node完整下载遇到网络超时，保留已验证结果后对剩余文件使用可续传下载完成，没有修改任何发布字节。

## 官网与应用内更新

- [官网下载页](https://agent.mikiko.ai/cn/download)真实浏览器显示v1.1.4；Intel链接为mac-x64.dmg，Apple Silicon为mac-arm64.dmg，浏览器DOM及聚合API均通过。
- stable清单五平台均为1.1.4；全部URL指向自建agent-dl的1.1.4目录，架构、大小、摘要匹配。
- 实际桌面 `ManifestUpdateProvider` + `NodeHttpExecutor` 通过真实公网请求，使用真实Updater类型的文件选择逻辑，五平台均解析到可从1.1.3升级的1.1.4；没有模拟网络或替用户执行系统安装。
- Windows ARM历史客户端实际发送windows-aarch64，服务已添加与windows-arm64相同的ARM专属清单路由，保留历史fallback；Worker29项及真实Provider公网请求通过。

## 自建服务恢复

- 官网tag部署39547367100成功。Source Server R2发布成功，公开catalog四目标均为1.1.4；归档和组件在CI上传后逐对象读回校验摘要，再提交索引。
- 手机页CI被25.1MiB调试map阻止；恢复上传排除map，运行时JS/CSS/HTML字节保留。公开主JS SHA256与同tag本地构建一致，后续恢复workflow39548577760的Pages/Relay也成功。
- 更新Worker的CI安装曾出现pnpm临时目录ENOENT；一次部署成功后旧探针因把相对path解析到域根而错误404。探针已修复版本前缀，真实公网Range通过。恢复workflow的更新job再次遇到依赖安装问题，不能称该workflow全绿。
- 更新Worker最终由本机既有Wrangler登录部署成功，部署版本`6b853744-6bef-466a-b300-3a99281ec881`，源码651d6155，含Windows ARM参数兼容；未修改用户账号/项目数据。

## 功能测试与最终权限验收

预生产完整回归见[原验证报告](../testing/v1.1.4-pre-release-validation.md)，正式Computer Use源码/原生/Electron用例见[Computer Use报告](../testing/mikiko-computer-use-production-2026-10-21.md)。当前功能验证包含gateway58、权限/资源/UI23、Node20、Swift11、CLI MCP66、Worker29；真实租约11项、签名升级7项、隔离Electron1项及自有Cocoa窗口截图/点击/中文emoji输入/滚动/真实鼠标拖拽/提前取消均通过。根typecheck、CLI类型图32/32、lint（0错误/174既有warning）、架构、notices hash及clean pre-push均通过。全量affected选择按仓库合同跳过重复根UT，不计作新全量执行。

**正式ZIP追加验收已通过：**真实下载的正式arm64 ZIP解压后，使用包内原样签名的嵌套Helper及独立gateway，完成真实截图（imageCount=1）、AX查询/读回、200ms延迟按钮一次副作用、中文emoji键盘输入、UTF16选区、窗口Raise、滚动、真实鼠标拖拽、stop后旧观察拒绝，以及提前取消后停止移动/恰好一次mouse-up。原生doctor明确返回本Helper身份、正式包内准确路径、AX=true、screenCapture=true、allGranted=true。

复测起初发现屏幕录制列表虽开启，但“在访达中显示”实际指向旧`release.before-final-e1b7e669`备份。用户给外层Mikiko授权后原生结果未变，因此该假设未被接受；随后用户只将屏幕录制中的Helper条目重新添加为正式包内准确Helper，重启后上述完整实测通过。没有修改TCC、绕过权限门禁或以独立flat副本/外部宿主权限代替正式嵌套Helper。多份本地副本的旧授权条目不能代表当前设置页显示路径的授权状态。

证据：`.cache/mikiko-release/final-installer-computer-use-proof.json`、`.cache/mikiko-release/final-installer-computer-use-fixture.png`、`/tmp/mikiko-v114-final-installer-computer-use-accepted-smoke.log`。完整步骤已收入本报告JSON。

Windows/Linux图形界面未在本机启动；对应证据为CI构建、源测试、真实更新Provider及完整下载验收。

## 下载与结论

- [官网下载](https://agent.mikiko.ai/cn/download)
- [Apple Silicon DMG](https://agent-dl.mikiko.ai/files/1.1.4/Mikiko-1.1.4-mac-arm64.dmg)
- [Intel Mac DMG](https://agent-dl.mikiko.ai/files/1.1.4/Mikiko-1.1.4-mac-x64.dmg)

发行使用v1.1.4，没有创建v1.1.5或移动版本tag。功能与发布门禁完成；验收记录提交后暂停本次发布跟进。
