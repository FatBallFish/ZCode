#!/usr/bin/env node
/* eslint-disable no-console */
// Release Notes 生成器：按 conventional commit 前缀把历史提交归类为 Features / BugFix / Optimize。
// 范围规则：上一个 v* tag..当前 tag；首个版本（无更早 tag）取该 tag 可达的全部历史。
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
const range = currentIndex + 1 < tags.length ? `${tags[currentIndex + 1]}..${tag}` : tag;

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

console.log(sections.join("\n\n").trimEnd());
