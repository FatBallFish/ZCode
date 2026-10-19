# macOS CI 签名修复计划

**Goal:** 修复临时钥匙链 300 秒自动锁定导致的 CI codesign 挂起，并恢复封装前完整签名。

**Architecture:** workflow 管理钥匙链生命周期；afterPack 签 glm/tools；builder 签主 App
并封装；公证脚本只处理最终 DMG。规则与顺序见 specs/desktop/macos-signing.md。
本任务已授权实施、推送修复及重新执行远端构建，不增加额外审批。

**Tech Stack:** Node 24、Vitest、Electron Builder、macOS security/codesign、GitHub Actions。

1. 为钥匙链有效期、异步运行时签名、Invalid 公证结果和双架构验收添加回归测试，先执行确认失败。
2. 修改 `.github/workflows/release-desktop.yml`、
   `packages/desktop/scripts/sign-runtime-executables.mjs`、
   `packages/desktop/electron-builder.config.js` 和 `scripts/notarize-macos.sh`；
   新增 `packages/desktop/scripts/refresh-macos-artifact-metadata.mjs`，staple 后同步 DMG 元数据；
   更新现有签名文档，不修改已有未跟踪的本地打包文档。
3. 执行聚焦测试、本地真实运行时签名、typecheck、lint、架构检查和格式检查。
4. 只提交本任务文件并推送当前分支。使用最新提交 dispatch mac-only，验证两个 bundle
   步骤结束；公证外部等待与编译/签名故障分别报告。
