# 可恢复公证与 v1.1.3 正式发布计划

**Goal:** 保存已签名产物与 Apple 提交记录，跨 runner 恢复公证及发布，正式发布 v1.1.3。

**Architecture:** build 保存不可变原包；notarize 独占状态、submit/wait/finalize 分段；
恢复通过 source-run-id 复用 build 与 relay，自动寻找相应状态 artifact；release/feed 可幂等重试。
规则见 specs/desktop/macos-signing.md。用户已授权推送、创建 v1.1.3 tag 及持续完成正式发布。

**Tech Stack:** Node 24、Vitest、GitHub Actions/Artifacts、Apple notarytool/stapler、electron-builder。

1. 先写失败测试：状态绑定、pending恢复、不重复提交、丢失响应找回、Invalid阻断、产物损坏拒绝。
2. 实现 artifact manifest、持久状态机与 macOS 收尾；ZIP 重建后的票据与更新元数据一同验证。
3. 拆分 workflow build/notarize，增加 source-run-id 恢复入口，原包和状态先保存再等待；发布幂等。
4. 补全文档故障矩阵与准确恢复命令；修正正式签名版本 release notes 的安装说明。
5. 执行测试、真实已有 Accepted 产物后处理、typecheck/lint/架构/格式及独立审查。
6. 更新 package.json/CHANGELOG/人工发布说明为 1.1.3，推送分支和全新 v1.1.3 tag。
7. 跟进真实全平台构建；遇公证 pending 或后处理故障只恢复原 run，不重新构建或提交。
8. 验证 GitHub Release 完整资产、签名公证证据与 feed 发布成功，记录实际运行及恢复结果。
