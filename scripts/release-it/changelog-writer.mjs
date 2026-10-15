import createConventionalCommitsPreset from "conventional-changelog-conventionalcommits";

/**
 * CHANGELOG 模板（specs/release/changelog-audience.md 的口径）：
 * 更新日志面向用户——只保留「新增功能 / 问题修复 / 体验优化」三个用户可感分区，
 * 分区名用中文大白话；chore/docs/refactor/test 等开发向类型不进入日志；
 * 开发工作流与云端服务（mikiko-cloud、pre-push、ci、e2e 等 scope）整体略过。
 */

export const RELEASE_CHANGELOG_TYPES = [
  { type: "feat", section: "新增功能" },
  { type: "fix", section: "问题修复" },
  { type: "perf", section: "体验优化" },
];

/** 用户无感的 scope：出现在这里面的提交不进入更新日志。 */
export const RELEASE_CHANGELOG_HIDDEN_SCOPES = new Set([
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
]);

export const RELEASE_CHANGELOG_PARSER_OPTS = {
  headerPattern: /^(?:(\w+)(?:\(([^)]*)\))?:\s+)?(.+)$/,
  breakingHeaderPattern: /^(\w+)(?:\(([^)]*)\))?!:\s+(.+)$/,
  headerCorrespondence: ["type", "scope", "subject"],
};

export function extractCommitBodyBullets(body) {
  if (typeof body !== "string" || body.trim() === "") {
    return [];
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*+]\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((item) => item && !/^BREAKING[ -]CHANGE:/i.test(item));
}

export function isHiddenReleaseScope(scope) {
  if (!scope) {
    return false;
  }
  // 逗号/斜杠复合 scope（如 "desktop/ui"）任一命中即隐藏。
  return scope
    .split(/[,/]/)
    .map((part) => part.trim())
    .some((part) => RELEASE_CHANGELOG_HIDDEN_SCOPES.has(part));
}

export function createReleaseChangelogWriterOpts() {
  const preset = createConventionalCommitsPreset({
    types: RELEASE_CHANGELOG_TYPES,
  });
  const baseWriter = preset.writer;
  const baseTransform = baseWriter.transform;

  return {
    ...baseWriter,
    commitPartial: `*{{#if scope}} **{{scope}}:**{{/if}} {{#if subject}}{{subject}}{{else}}{{header}}{{/if}}{{#if hash}} {{#if @root.linkReferences}}([{{shortHash}}]({{@root.host}}/{{@root.owner}}/{{@root.repository}}/commit/{{hash}})){{else}}{{shortHash}}{{/if}}{{/if}}{{#if references}}, closes{{#each references}} {{#if @root.linkReferences}}[{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}{{this.prefix}}{{this.issue}}]({{issueUrlFormat}}){{else}}{{#if this.owner}}{{this.owner}}/{{/if}}{{this.repository}}{{this.prefix}}{{this.issue}}{{/if}}{{/each}}{{/if}}
{{#if bodyBullets}}{{#each bodyBullets}}  * {{this}}
{{/each}}{{/if}}
`,
    transform(commit, context) {
      if (isHiddenReleaseScope(commit.scope)) {
        // 返回 falsy 即从 changelog 中剔除该提交。
        return null;
      }

      const transformed = baseTransform(commit, context);
      if (!transformed) {
        return transformed;
      }

      const bodyBullets = extractCommitBodyBullets(commit.body);
      if (bodyBullets.length === 0) {
        return transformed;
      }

      return {
        ...transformed,
        bodyBullets,
      };
    },
  };
}
