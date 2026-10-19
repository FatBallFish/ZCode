import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 回归背景：语音输入浮窗曾在暗色主题下无背景、文字不可读——原因是 className 引用了
// @theme 未定义的简写 token（bg 前缀的 surface 类、fg 前缀的 foreground 类），Tailwind v4
// 只为 @theme 已定义 token 生成工具类，这些 class 编译产物为空。本守卫扫描全部 UI 源码，
// 防止再次写入不存在的主题 token（specs/desktop/voice-input.md、DESIGN.md「Core semantic colors」）。
const UI_SRC_ROOT = join(import.meta.dirname, "..", "src");

// 已知不存在的 token 家族：bg-bg-*（surface 简写）与 text-fg / text-fg-*（foreground 简写）。
// 注意 text-foreground* 是合法 token，不匹配本模式（fg 后是 r，词边界成立）。
const INVALID_TOKEN_PATTERNS: RegExp[] = [
  /\bbg-bg-[a-z]/,
  /\btext-fg\b/,
  /\btext-fg-[a-z]/,
];

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (/\.(tsx?|mts)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

describe("voice-theme-token guard（主题 token 存在性守卫）", () => {
  it("packages/ui/src 不引用 @theme 未定义的简写 token", () => {
    expect(statSync(UI_SRC_ROOT).isDirectory()).toBe(true);
    const violations: string[] = [];
    for (const file of collectSourceFiles(UI_SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      for (const pattern of INVALID_TOKEN_PATTERNS) {
        const match = pattern.exec(content);
        if (match) {
          violations.push(
            `${file.replace(join(UI_SRC_ROOT, "..", ".."), "")}: 不存在的 token 模式 ${pattern}（命中 "${match[0]}"）`,
          );
          break;
        }
      }
    }
    expect(
      violations,
      `以下文件使用了 @theme 未定义的主题 token（Tailwind v4 不会生成这些工具类，暗色主题会失去背景/前景色）：\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
