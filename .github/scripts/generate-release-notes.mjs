#!/usr/bin/env node
/* eslint-disable no-console */
// Release Notes 生成器：按 conventional commit 前缀把提交归类为 Features / BugFix / Optimize。
// 范围规则：版本倒序中第一个「当前 tag 真实祖先」的 tag..当前 tag——历史被 rebase 改写后
// 旧 tag 不再可达，直接拿它当基线会让 range 排除不掉任何提交、全量历史灌进 Notes
// （2026-09-25 v1.0.2 教训：v1.0.1 指向改写前旧提交，23/25 条进了 Notes）。
// 无祖先 tag（首个版本或全部历史已改写）时取该 tag 可达的全部历史。
// 分类为空时省略整节（“若无则空着”）；docs/ci/test/chore 等杂项不进入 Notes。
// 用法：node generate-release-notes.mjs <tag>

import { execFileSync } from "node:child_process";

const tag = process.argv[2];
if (!tag) {
  console.error("用法: generate-release-notes.mjs <tag>");
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isAncestor(base, tip) {
  // merge-base --is-ancestor：base 是 tip 的祖先时退出码 0，否则 1。
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, tip], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listPreviousTags() {
  // 按版本号倒序列出 v* tag；当前 tag 之后的第一个即“上一个正式版本”。
  return git(["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const tags = listPreviousTags();
const currentIndex = tags.indexOf(tag);
if (currentIndex === -1) {
  console.error(`generate-release-notes: tag ${tag} 不存在（先推 tag 再跑本脚本）`);
  process.exit(1);
}
const baseTag = tags.slice(currentIndex + 1).find((candidate) => isAncestor(candidate, tag));
const range = baseTag ? `${baseTag}..${tag}` : tag;

const subjects = git(["log", range, "--no-merges", "--pretty=format:%s"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const categories = [
  { title: "Features", pattern: /^(feat|feature|add)(\([^)]*\))?!?:/i },
  { title: "BugFix", pattern: /^(fix|bugfix|hotfix|fixup)(\([^)]*\))?!?:/i },
  {
    title: "Optimize",
    pattern: /^(perf|refactor|optimize|optimization|style)(\([^)]*\))?!?:/i,
  },
];

function cleanSubject(subject) {
  // 去掉 conventional 前缀与 scope，保留人类可读的部分。
  return subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").trim();
}

const sections = [];
for (const category of categories) {
  const items = [...new Set(subjects.filter((s) => category.pattern.test(s)).map(cleanSubject))]
    .filter(Boolean)
    .map((item) => `- ${item}`);
  if (items.length === 0) continue;
  sections.push(`## ${category.title}\n\n${items.join("\n")}`);
}

// Mac 未签名安装指引：与 DMG 内「安装必读.txt」同一口径（specs/desktop/dmg-installer.md）。
// 当前 Mac 包走无证书模式发布，Release 里必须附带清除隔离标记的命令；
// 待启用 Developer ID 签名与公证后，删除本段与 DMG 注入逻辑一并对齐。
sections.push(
  [
    "## 💻 Mac 安装说明",
    "",
    "Mac 安装包暂未做 Apple 开发者签名与公证，首次打开可能被系统拦截",
    "（提示「无法验证开发者」或「文件已损坏」）。请先把 **Mikiko** 拖入 **Applications** 文件夹，",
    "然后打开「终端」执行以下命令清除隔离标记，再从 Applications 启动：",
    "",
    "```bash",
    "xattr -rc /Applications/Mikiko.app",
    "```",
    "",
    "若提示权限不足，请改用：`sudo xattr -rc /Applications/Mikiko.app`（需输入开机密码）。",
    "该命令只移除下载文件附带的隔离标记，不修改系统设置。DMG 内也附有同名说明文件「安装必读.txt」。",
  ].join("\n"),
);

console.log(sections.join("\n\n").trimEnd());
