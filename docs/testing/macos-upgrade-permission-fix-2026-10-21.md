# macOS 自动升级权限修复验证（源码提交，不打包）

## 根因与范围

用户实测1.1.2点击“重启并安装”卡住，日志确认两段故障：旧版退出标记过早清除造成安装重入；旧进程退出后，ShipIt清理新包LICENSE.libwebp.txt的quarantine遇到0444只读模式而EACCES，三次失败后重启1.1.2。当前源码已有退出重入修复，本次复核其测试；新增修复针对Helper打包权限，未修改安装到用户电脑上的1.1.2。

实现按[权限规格](../../specs/desktop/macos-auto-update-bundle-permissions.md)：新Helper首次签名前补owner-write，保留内容/执行位/其余权限，不跟随符号链接。依赖checkout及已签缓存保持原样；stage/afterPack发现只读条目即拒绝。权限策略摘要加入build input和provenance，防止后续策略改动复用旧缓存。

## 实际执行

| 验证                             | 结果                                                                          | 证据                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 权限回归红态                     | 合成许可证0444移除quarantine真实EACCES；原finalizer未拒绝只读资源             | `/tmp/mikiko-upgrade-permissions-red.log`、`/tmp/mikiko-upgrade-finalizer-red.log`                  |
| 权限/构建合同Node测试            | 16/16，含真实macOS xattr、源只读保留、执行位、符号链接、stage拒绝及签名前拦截 | `/tmp/mikiko-upgrade-permissions-green.log`                                                         |
| 更新器与electron-builder安全合同 | 86/86                                                                         | `/tmp/mikiko-upgrade-updater-tests.log`                                                             |
| Electron退出时序                 | PASS；prepare/install/native install各一次，退出码0；原生安装器仍为隔离夹具   | `/tmp/mikiko-upgrade-reentry-smoke.log`                                                             |
| 根类型检查                       | 通过                                                                          | `/tmp/mikiko-upgrade-fix-typecheck.log`                                                             |
| 根lint                           | 0错误，174项既有warning                                                       | `/tmp/mikiko-upgrade-fix-lint.log`                                                                  |
| 架构                             | 改动前后0 violation                                                           | `/tmp/mikiko-upgrade-fix-architecture-before.log`、`/tmp/mikiko-upgrade-fix-architecture-after.log` |

独立只读评审未发现可行动问题，复核了权限写入边界、缓存指纹和签名顺序，并独立复跑16项Node测试通过。

## 尚未执行

按用户本轮要求，不编译/生成正式App、DMG或ZIP，不修改发布tag、安装包或更新清单，不启动发布工作流。真实签名安装包的ShipIt文件替换及重启必须在后续获准打包时再验证，不能用本次文件操作/进程夹具测试代替。

已发布1.1.4包仍带原始权限问题；本次源码修复未改变线上字节。1.1.2旧进程的退出重入不能被尚未安装的目标代码修复，旧客户端首次过渡应使用DMG覆盖安装。后续发版使用新版本，不能移动已发布1.1.4 tag。
