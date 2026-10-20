# Mikiko Source Server 自建分发合同

- Desktop 默认版本根为 `https://agent-dl.mikiko.ai/mikiko/electron/releases/<version>`。
- 版本根下读取 `source-server-release.json`，archive 文件名使用 `mikiko-server-<target>.tar.gz`，下载后继续执行既有 SHA256/size 校验；不按语言/时区切回上游 CDN。
- `MIKIKO_CDN_BASE_URL` 是分发域/公共前缀覆盖，继续附加 `/mikiko/electron/releases/<version>`；显式 `overrideBaseUrl` 仍表示完整 release root，保持现有本地/自建覆盖合同。
- CLI 的自建版本索引为 `https://agent-dl.mikiko.ai/mikiko/server/catalog.json`；目录索引、descriptor、archive 的版本和兼容门槛由自建发布链保持一致。
- 上游官方产品 CDN 和内部测试地址不作为默认或恢复 fallback。官方 CodingPlan 账号例外不适用于资源下载。
- 实际 E2E 验收消费隔离本地产物，不访问生产分发服务。测试在 loopback HTTP server 上验证从当前 resolver 生成版本根，读取 descriptor、下载 archive 并校验缓存；不能只比较拼接字符串。

# 生产态远端开发入口

`dev:desktop:remote-prod` 必须强制 `MIKIKO_ENV=production` 与 `MIKIKO_DEV_REMOTE_ASSET_USE_CDN=1`，不能只写不再读取的旧名而被继承的 `0` 覆盖。默认缓存采用桌面 production product identity 的 Mikiko 用户数据目录；macOS/Linux/Windows 各走对应路径规则，显式 `MIKIKO_REMOTE_ASSET_CACHE_DIR` 保持优先。不读取官方 ZCode 的资源缓存，不改生产安装或个人数据。
