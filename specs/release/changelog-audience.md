# 更新日志口径（面向用户）

状态：2026-10-15 生效。适用两处产出口径必须一致：

1. **GitHub Release body**（`.github/scripts/generate-release-notes.mjs`）——应用内「发现更新」弹窗与安装后说明的唯一来源（经 mikiko-cloud `releases.ts` 以 `rn:` KV 分发）；
2. **CHANGELOG.md**（`scripts/release-it/changelog-writer.mjs`，release-it 生成 + 必要时人工整理）。

## 原则

- 更新日志是**给用户看的**，不是给开发者看的：通俗易懂、一目了然，避免专业术语、机制名词（如 IPC、CDP、token、store、协议、scheme 等）与内部模块名。
- 只写用户可感的变化；用户无感的内部实现不写。
- **开发工作流与云端服务变更**（mikiko-cloud、pre-push/architecture/ci/e2e/sync/test 等 scope、构建与基建）默认不进日志，必要时一句话带过。
- 功能性变更尽量回答「用户能做什么新事情 / 什么问题不再发生」，而不是「代码改了什么」。

## 机制

- **人工覆盖优先**：`.github/release-notes/<tag>.md` 存在时，Release Notes 完全使用该文件（推荐每个正式版本手写，质量最高）。文件不需要附带 Mac 安装说明（脚本只对自动生成的路径追加）。
- **自动兜底**：无覆盖文件时按 conventional commit 归类为「✨ 新增 / 🛠 修复 / ⚡ 优化」，隐藏 scope 名单见 `HIDDEN_SCOPES`；commit subject 即用户文案——**feat/fix 的标题行请直接写用户语言**（这份 discipline 是自动路径质量的前提）。
- **范围基线**：默认取「当前 tag 的最近可达祖先 tag」；分支被 rebase 改写导致无可达历史 tag 时，必须 `--base <上一版本在新历史中的 release commit>` 显式指定（或提供覆盖文件），脚本会拒绝生成而不是把全量历史灌进日志。

## 验收

- 每个正式版本的 Release body 通读一遍：无术语、无内部 scope、每条都是用户视角；
- CHANGELOG.md 同版本段落与 Release body 同口径（允许更简）。
