#!/usr/bin/env node
/* eslint-disable no-console */
// Release Notes 生成器（用户侧更新日志的唯一来源：GitHub Release body → 应用内
// 「发现更新」弹窗与安装后说明，见 release-desktop.yml 与 mikiko-cloud releases.ts）。
//
// 口径（specs/release/changelog-audience.md）：面向用户、通俗易懂、一目了然——
// 1. 优先使用人工撰写的 .github/release-notes/<tag>.md（推荐方式，文案完全用户向）；
// 2. 无覆盖文件时按 conventional commit 自动归类为「✨ 新增 / 🛠 修复 / ⚡ 优化」，
//    开发工作流与云端服务（mikiko-cloud、pre-push、ci、e2e 等 scope）不进入日志；
// 3. 范围规则：版本倒序中第一个「当前 tag 真实祖先」的 tag..当前 tag——历史被 rebase
//    改写后旧 tag 不再可达（2026-09-25 v1.0.2 教训），此时必须用 --base 显式指定
//    基线（通常为上一版本在新历史中的 release commit），否则直接报错退出，
//    绝不把全量历史灌进 Notes。
// 用法：node generate-release-notes.mjs <tag> [--base <ref>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const baseFlagIndex = args.indexOf("--base");
const explicitBase =
  baseFlagIndex !== -1 ? args[baseFlagIndex + 1]?.trim() : process.env.RELEASE_NOTES_BASE?.trim();
// --base 与其取值成对剔除；无该 flag 时不能把第 0 位（tag）误过滤掉。
const excludedIndexes =
  baseFlagIndex === -1 ? new Set() : new Set([baseFlagIndex, baseFlagIndex + 1]);
const positionalArgs = args.filter((_, index) => !excludedIndexes.has(index));
const tag = positionalArgs[0];
if (!tag) {
  console.error("用法: generate-release-notes.mjs <tag> [--base <ref>]");
  process.exit(1);
}

function git(gitArgs) {
  return execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
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

// Mac 未签名安装指引：与 DMG 内「安装必读.txt」同一口径（specs/desktop/dmg-installer.md）。
// 当前 Mac 包走无证书模式发布，Release 里必须附带清除隔离标记的命令；
// 待启用 Developer ID 签名与公证后，删除本段与 DMG 注入逻辑一并对齐。
// 人工覆盖文件同样追加本段：安装指引属于发布必备内容，不依赖手写文件记得带。
const MAC_INSTALL_SECTION = [
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
].join("\n");

// 人工覆盖文件优先：文案完全用户向，原样输出（自动追加 Mac 安装说明）。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const overridePath = join(scriptDir, "..", "release-notes", `${tag}.md`);
if (existsSync(overridePath)) {
  console.log(`${readFileSync(overridePath, "utf8").trimEnd()}\n\n${MAC_INSTALL_SECTION}`);
  process.exit(0);
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

let range;
if (explicitBase) {
  if (!isAncestor(explicitBase, tag)) {
    console.error(`generate-release-notes: --base ${explicitBase} 不是 ${tag} 的祖先`);
    process.exit(1);
  }
  range = `${explicitBase}..${tag}`;
} else if (baseTag) {
  range = `${baseTag}..${tag}`;
} else {
  console.error(
    [
      `generate-release-notes: 找不到 ${tag} 的可达历史 tag（分支历史被改写）。`,
      "请用 --base <上一版本在新历史中的 release commit> 显式指定基线，",
      "或提供 .github/release-notes/" + tag + ".md 人工覆盖文件。",
    ].join("\n"),
  );
  process.exit(1);
}

// 用户无感的 scope：开发工作流 / 云端服务 / 内部基建，不进入用户日志。
const HIDDEN_SCOPES = new Set([
  "mikiko-cloud",
  "cloud",
  "pre-push",
  "architecture",
  "knip",
  "ci",
  "e2e",
  "sync",
  "test",
  "release",
  "brand",
  "site",
  "spec",
  "specs",
  "docs",
]);

function isHiddenScope(scope) {
  return scope
    .split(/[,/]/)
    .map((part) => part.trim())
    .some((part) => HIDDEN_SCOPES.has(part));
}

const subjects = git(["log", range, "--no-merges", "--pretty=format:%s"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const categories = [
  { title: "✨ 新增", pattern: /^(feat|feature|add)(\(([^)]*)\))?!?:/i },
  { title: "🛠 修复", pattern: /^(fix|bugfix|hotfix|fixup)(\(([^)]*)\))?!?:/i },
  {
    title: "⚡ 优化",
    pattern: /^(perf|refactor|optimize|optimization|style)(\(([^)]*)\))?!?:/i,
  },
];

function cleanSubject(subject) {
  // 去掉 conventional 前缀与 scope，保留人类可读的部分。
  return subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").trim();
}

function scopeOf(subject) {
  return subject.match(/^[a-z]+\(([^)]*)\)!?:/i)?.[1] ?? "";
}

const sections = [];
for (const category of categories) {
  const items = [
    ...new Set(
      subjects
        .filter((subject) => category.pattern.test(subject) && !isHiddenScope(scopeOf(subject)))
        .map(cleanSubject),
    ),
  ]
    .filter(Boolean)
    .map((item) => `- ${item}`);
  if (items.length === 0) continue;
  sections.push(`## ${category.title}\n\n${items.join("\n")}`);
}

if (sections.length === 0) {
  console.error(`generate-release-notes: ${range} 内没有可进入用户日志的提交`);
  process.exit(1);
}

sections.push(MAC_INSTALL_SECTION);

console.log(sections.join("\n\n").trimEnd());
